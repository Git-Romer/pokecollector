import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, Check, RefreshCw, X } from 'lucide-react'

import { useSettings } from '../contexts/SettingsContext'
import {
  DEFAULT_STABILITY_THRESHOLDS,
  computeContentScore,
  computeMotionScore,
  evaluateStability,
  SAMPLE_SIZE,
  toGrayscale,
} from '../utils/webcamStability'

const SAMPLE_INTERVAL_MS = 100 // ~10fps stability sampling — plenty for frame-differencing, easy on CPU/battery
const FLASH_DURATION_MS = 400

/**
 * Live webcam feed with a card-shaped guide box. Auto-captures a JPEG frame
 * once the scene stops moving and the guide box is filled (see
 * ../utils/webcamStability.js), and always offers a manual capture button /
 * Space-Enter shortcut as a fallback. Captured frames are handed to
 * `onCapture` as plain Files — the caller (UnifiedCardScanner) stages them
 * exactly like a "Take Photo"/gallery pick, so this component knows nothing
 * about the scan pipeline itself.
 */
export default function WebcamCapture({ onCapture, onExit, maxReached }) {
  const { t } = useSettings()
  const [status, setStatus] = useState('requesting') // requesting | live | denied | no-camera | error
  const [retryToken, setRetryToken] = useState(0)
  const [flash, setFlash] = useState(false)

  const videoRef = useRef(null)
  const guideRef = useRef(null)
  const sampleCanvasRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const streamRef = useRef(null)
  const encodingRef = useRef(null)
  const rafRef = useRef(null)
  const flashTimeoutRef = useRef(null)
  const stabilityRef = useRef({ stableSinceTs: null, armed: true })
  const lastGrayRef = useRef(null)

  if (!sampleCanvasRef.current && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    sampleCanvasRef.current = canvas
  }
  if (!captureCanvasRef.current && typeof document !== 'undefined') {
    captureCanvasRef.current = document.createElement('canvas')
  }

  const triggerFlash = useCallback(() => {
    setFlash(true)
    clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setFlash(false), FLASH_DURATION_MS)
  }, [])

  const captureFrame = useCallback(() => {
    const video = videoRef.current
    const canvas = captureCanvasRef.current
    const stream = streamRef.current
    if (!video || !canvas || !video.videoWidth || !stream || encodingRef.current) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const encoding = {}
    encodingRef.current = encoding
    canvas.toBlob(blob => {
      if (encodingRef.current === encoding) encodingRef.current = null
      if (!blob || streamRef.current !== stream) return
      onCapture(new File([blob], `webcam-${Date.now()}.jpg`, { type: 'image/jpeg' }))
      triggerFlash()
    }, 'image/jpeg', 0.92)
    // A capture (auto or manual) always disarms auto-capture until the scene
    // changes again, so a still-held card can't immediately re-trigger.
    stabilityRef.current = { ...stabilityRef.current, armed: false }
  }, [onCapture, triggerFlash])

  const handleManualCapture = useCallback(() => {
    if (status !== 'live' || maxReached) return
    captureFrame()
  }, [status, maxReached, captureFrame])

  // Each request owns its stream, including permission grants arriving after exit.
  useEffect(() => {
    let cancelled = false
    let stream = null

    const stop = () => {
      const previous = stream
      stream = null
      previous?.getTracks().forEach(track => {
        track.removeEventListener('ended', onEnded)
        track.stop()
      })
      if (streamRef.current === previous) {
        streamRef.current = null
        encodingRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
      }
    }
    const onEnded = () => {
      if (cancelled) return
      stop()
      setStatus('error')
    }
    const start = async () => {
      setStatus('requesting')
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
        if (cancelled) {
          stop()
          return
        }
        streamRef.current = stream
        stream.getTracks().forEach(track => track.addEventListener('ended', onEnded))
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        if (cancelled || !stream || streamRef.current !== stream) return
        lastGrayRef.current = null
        stabilityRef.current = { stableSinceTs: null, armed: true }
        setStatus('live')
      } catch (error) {
        if (cancelled) return
        const acquired = Boolean(stream)
        stop()
        if (!acquired && (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError')) {
          setStatus('denied')
        } else if (!acquired && (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError')) {
          setStatus('no-camera')
        } else {
          setStatus('error')
        }
      }
    }
    start()
    return () => { cancelled = true; stop() }
  }, [retryToken])

  // Frame-differencing loop: auto-captures once a card settles into the guide box.
  useEffect(() => {
    if (status !== 'live') return undefined
    let cancelled = false
    let lastSampleTs = 0
    const sampleCtx = sampleCanvasRef.current.getContext('2d', { willReadFrequently: true })

    const tick = timestamp => {
      if (cancelled) return
      rafRef.current = requestAnimationFrame(tick)
      const video = videoRef.current
      if (!video || video.readyState < 2) return
      if (timestamp - lastSampleTs < SAMPLE_INTERVAL_MS) return
      lastSampleTs = timestamp

      const preview = video.getBoundingClientRect()
      const guide = guideRef.current?.getBoundingClientRect()
      if (!guide || !preview.width || !preview.height) return
      // Match the source region to the guide after object-cover crops the preview.
      const scale = Math.max(preview.width / video.videoWidth, preview.height / video.videoHeight)
      const sourceX = Math.max(0, (guide.left - preview.left + (video.videoWidth * scale - preview.width) / 2) / scale)
      const sourceY = Math.max(0, (guide.top - preview.top + (video.videoHeight * scale - preview.height) / 2) / scale)
      const sourceWidth = Math.min(video.videoWidth - sourceX, guide.width / scale)
      const sourceHeight = Math.min(video.videoHeight - sourceY, guide.height / scale)
      if (sourceWidth <= 0 || sourceHeight <= 0) return
      sampleCtx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const gray = toGrayscale(sampleCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE))
      const motionScore = computeMotionScore(lastGrayRef.current, gray)
      const contentScore = computeContentScore(gray)
      lastGrayRef.current = gray

      const result = evaluateStability({
        motionScore,
        contentScore,
        ...stabilityRef.current,
        thresholds: DEFAULT_STABILITY_THRESHOLDS,
        now: Date.now(),
        armed: stabilityRef.current.armed,
      })
      stabilityRef.current = result
      if (result.shouldCapture && !maxReached) captureFrame()
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [status, maxReached, captureFrame])

  useEffect(() => {
    if (status !== 'live') return undefined
    const onKeyDown = event => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.target instanceof Element && event.target.closest(
        'button, input, select, textarea, a, [role="button"], [contenteditable]:not([contenteditable="false"])',
      )) return
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault()
        handleManualCapture()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [status, handleManualCapture])

  useEffect(() => () => clearTimeout(flashTimeoutRef.current), [])

  return (
    <div className="space-y-3">
      <div className="relative h-[clamp(6rem,calc(85dvh-16rem),34rem)] sm:aspect-video sm:h-auto sm:max-h-[calc(85dvh-16rem)] overflow-hidden rounded-2xl border border-white/10 bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`h-full w-full object-cover ${status === 'live' ? '' : 'opacity-0'}`}
        />

        {status === 'live' && (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div ref={guideRef} data-camera-guide className="relative aspect-[2.5/3.5] h-[84%] max-w-[90%] rounded-2xl border-2 border-yellow/80">
                <span className="absolute left-2 top-2 h-5 w-5 border-l-2 border-t-2 border-white" />
                <span className="absolute right-2 top-2 h-5 w-5 border-r-2 border-t-2 border-white" />
                <span className="absolute bottom-2 left-2 h-5 w-5 border-b-2 border-l-2 border-white" />
                <span className="absolute bottom-2 right-2 h-5 w-5 border-b-2 border-r-2 border-white" />
              </div>
            </div>
            <p className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-xs font-medium text-white/90 drop-shadow">
              {t('scanner.webcamGuideText')}
            </p>
          </>
        )}

        {flash && (
          <div
            className="absolute inset-0 flex animate-fade-in items-center justify-center bg-white/80"
            role="status"
            aria-live="polite"
          >
            <span className="sr-only">{t('scanner.webcamCaptured')}</span>
            <Check size={48} className="text-green" />
          </div>
        )}

        {status === 'requesting' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-secondary">
            {t('common.loading')}
          </div>
        )}

        {(status === 'denied' || status === 'no-camera' || status === 'error') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle size={28} className="text-yellow" />
            <p className="text-sm text-text-secondary">
              {status === 'denied' && t('scanner.webcamPermissionDenied')}
              {status === 'no-camera' && t('scanner.webcamNoCamera')}
              {status === 'error' && t('scanner.webcamStreamError')}
            </p>
            <button
              type="button"
              onClick={() => setRetryToken(token => token + 1)}
              className="btn-secondary flex items-center gap-2"
            >
              <RefreshCw size={14} />
              <span>{t('scanner.webcamTryAgain')}</span>
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleManualCapture}
          disabled={status !== 'live' || maxReached}
          title={maxReached ? t('scanner.batchLimitReached') : undefined}
          className="btn-primary flex items-center justify-center gap-2"
        >
          <Camera size={16} />
          <span>{t('scanner.webcamCapture')}</span>
        </button>
        <button
          type="button"
          onClick={onExit}
          className="btn-secondary flex items-center justify-center gap-2"
        >
          <X size={16} />
          <span>{t('scanner.webcamDone')}</span>
        </button>
      </div>
    </div>
  )
}
