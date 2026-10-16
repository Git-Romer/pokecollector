import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, Check, RefreshCw, X } from 'lucide-react'

import { useSettings } from '../contexts/SettingsContext'
import {
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
  const [devices, setDevices] = useState([])
  const [activeDeviceId, setActiveDeviceId] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const [flash, setFlash] = useState(false)

  const videoRef = useRef(null)
  const sampleCanvasRef = useRef(null)
  const captureCanvasRef = useRef(null)
  const streamRef = useRef(null)
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
    if (!video || !canvas || !video.videoWidth) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) return
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

  // Acquire (and re-acquire on device switch / retry) the camera stream.
  useEffect(() => {
    let cancelled = false

    const start = async () => {
      setStatus('requesting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            ...(activeDeviceId ? { deviceId: { exact: activeDeviceId } } : {}),
          },
        })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        lastGrayRef.current = null
        stabilityRef.current = { stableSinceTs: null, armed: true }
        setStatus('live')
        try {
          const allDevices = await navigator.mediaDevices.enumerateDevices()
          if (!cancelled) setDevices(allDevices.filter(device => device.kind === 'videoinput'))
        } catch {
          // Device labels are a nice-to-have; ignore enumeration failures.
        }
      } catch (error) {
        if (cancelled) return
        if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
          setStatus('denied')
        } else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
          setStatus('no-camera')
        } else {
          setStatus('error')
        }
      }
    }

    start()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [activeDeviceId, retryToken])

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

      sampleCtx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const gray = toGrayscale(sampleCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE))
      const motionScore = computeMotionScore(lastGrayRef.current, gray)
      const contentScore = computeContentScore(gray)
      lastGrayRef.current = gray

      const result = evaluateStability({
        motionScore,
        contentScore,
        stableSinceTs: stabilityRef.current.stableSinceTs,
        now: Date.now(),
        armed: stabilityRef.current.armed,
      })
      stabilityRef.current = { stableSinceTs: result.stableSinceTs, armed: result.armed }
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
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`h-full w-full object-cover ${status === 'live' ? '' : 'opacity-0'}`}
        />

        {status === 'live' && (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="relative aspect-[2.5/3.5] h-full max-w-full rounded-2xl border-2 border-yellow/80">
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

      {devices.length > 1 && status === 'live' && (
        <select
          value={activeDeviceId}
          onChange={event => setActiveDeviceId(event.target.value)}
          className="select w-full text-sm"
          aria-label={t('scanner.webcamSelectCamera')}
        >
          <option value="">{t('scanner.webcamSelectCamera')}</option>
          {devices.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `${t('scanner.webcamSelectCamera')} ${index + 1}`}
            </option>
          ))}
        </select>
      )}

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
