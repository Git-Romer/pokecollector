// Pure, DOM-free helpers for detecting when a card has been held steady in
// front of a live webcam feed, so WebcamCapture.jsx can auto-capture without
// pulling in any image-recognition or ML dependency — just frame-differencing
// on a small downsampled grayscale sample.

export const SAMPLE_SIZE = 64

export const DEFAULT_STABILITY_THRESHOLDS = {
  // Mean grayscale delta (0-255 scale) between consecutive sampled frames
  // below which the scene counts as "not moving".
  motionThreshold: 6,
  // Edge-energy below which the guide box counts as empty (blank desk/background)
  // rather than filled with a textured card.
  contentThreshold: 10,
  // How long the frame must stay below motionThreshold before a capture fires.
  stableDurationMs: 700,
  // Motion spike required, after a capture, to clear the "already captured
  // this card" lock — distinctly larger than the jitter of a steadily held
  // card, so removing/replacing the card is what re-arms auto-capture.
  rearmMotionThreshold: 18,
}

// Converts an ImageData (from a downsampled offscreen canvas) into a plain
// grayscale sample array cheap enough to diff every animation frame.
export function toGrayscale(imageData) {
  const { data } = imageData
  const gray = new Float32Array(data.length / 4)
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  }
  return gray
}

// Mean absolute per-pixel delta between two grayscale samples of the same
// shape. Returns Infinity when there is no previous frame to compare against
// (e.g. the very first sampled frame), which correctly reads as "moving".
export function computeMotionScore(prevGray, currGray) {
  if (!prevGray || !currGray || !currGray.length || prevGray.length !== currGray.length) {
    return Infinity
  }
  let sum = 0
  for (let i = 0; i < currGray.length; i += 1) {
    sum += Math.abs(currGray[i] - prevGray[i])
  }
  return sum / currGray.length
}

// Mean absolute delta between horizontally-adjacent pixels in one grayscale
// frame, as a cheap edge-energy proxy for "is there something textured here"
// versus a flat, low-contrast background.
export function computeContentScore(gray, width = SAMPLE_SIZE) {
  if (!gray || !gray.length) return 0
  let sum = 0
  let count = 0
  for (let i = 0; i < gray.length - 1; i += 1) {
    if ((i + 1) % width === 0) continue
    sum += Math.abs(gray[i + 1] - gray[i])
    count += 1
  }
  return count ? sum / count : 0
}

// Advances the stability state machine by one sampled frame and reports
// whether this frame should trigger an auto-capture.
//
// State (stableSinceTs, armed) is threaded through by the caller (kept in a
// ref, not React state, since it updates every animation frame) rather than
// held internally, so this stays a pure function.
export function evaluateStability({
  motionScore,
  contentScore,
  stableSinceTs,
  now,
  armed,
  thresholds = DEFAULT_STABILITY_THRESHOLDS,
}) {
  const { motionThreshold, contentThreshold, stableDurationMs, rearmMotionThreshold } = thresholds

  const isMoving = motionScore > motionThreshold
  const nextStableSinceTs = isMoving ? null : (stableSinceTs ?? now)
  const nextArmed = armed || motionScore > rearmMotionThreshold
  const isStableLongEnough = nextStableSinceTs != null && now - nextStableSinceTs >= stableDurationMs
  const isFilled = contentScore > contentThreshold
  const shouldCapture = Boolean(nextArmed && isStableLongEnough && isFilled)

  return {
    shouldCapture,
    stableSinceTs: nextStableSinceTs,
    // A firing capture immediately disarms itself; re-arming requires a
    // fresh motion spike on a later frame (card removed/replaced).
    armed: shouldCapture ? false : nextArmed,
  }
}
