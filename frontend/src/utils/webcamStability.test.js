import { describe, expect, it } from 'vitest'

import {
  computeContentScore,
  computeMotionScore,
  DEFAULT_STABILITY_THRESHOLDS,
  evaluateStability,
} from './webcamStability'

describe('computeMotionScore', () => {
  it('is zero for two identical frames', () => {
    const frame = new Float32Array([10, 20, 30, 40])
    expect(computeMotionScore(frame, frame)).toBe(0)
  })

  it('is the mean absolute delta between frames', () => {
    const prev = new Float32Array([0, 0, 0, 0])
    const curr = new Float32Array([10, 20, 30, 40])
    expect(computeMotionScore(prev, curr)).toBe(25)
  })

  it('is Infinity when there is no previous frame', () => {
    expect(computeMotionScore(null, new Float32Array([1, 2]))).toBe(Infinity)
  })
})

describe('computeContentScore', () => {
  it('is zero for a flat (blank) frame', () => {
    const flat = new Float32Array(16).fill(128)
    expect(computeContentScore(flat, 4)).toBe(0)
  })

  it('is positive for a textured frame', () => {
    // Alternating light/dark pixels across each row of a 4x4 sample.
    const textured = new Float32Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255])
    expect(computeContentScore(textured, 4)).toBeGreaterThan(0)
  })
})

describe('evaluateStability', () => {
  const thresholds = DEFAULT_STABILITY_THRESHOLDS

  it('does not capture while the frame is still moving', () => {
    const result = evaluateStability({
      motionScore: thresholds.motionThreshold + 5,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: null,
      now: 1000,
      armed: true,
    })
    expect(result.shouldCapture).toBe(false)
    expect(result.stableSinceTs).toBeNull()
    expect(result.armed).toBe(true)
  })

  it('does not capture until the frame has been stable for the full debounce window', () => {
    let state = { stableSinceTs: null, armed: true }

    // Frame settles at t=0.
    state = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: state.stableSinceTs,
      now: 0,
      armed: state.armed,
    })
    expect(state.shouldCapture).toBe(false)
    expect(state.stableSinceTs).toBe(0)

    // Still short of the debounce window.
    state = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: state.stableSinceTs,
      now: thresholds.stableDurationMs - 1,
      armed: state.armed,
    })
    expect(state.shouldCapture).toBe(false)
    expect(state.stableSinceTs).toBe(0)

    // Debounce window elapsed with the box filled: captures.
    state = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: state.stableSinceTs,
      now: thresholds.stableDurationMs,
      armed: state.armed,
    })
    expect(state.shouldCapture).toBe(true)
    expect(state.armed).toBe(false)
  })

  it('does not capture a frame that is stable but empty', () => {
    const result = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold - 1,
      stableSinceTs: 0,
      now: thresholds.stableDurationMs,
      armed: true,
    })
    expect(result.shouldCapture).toBe(false)
  })

  it('does not re-fire on the same still-held card after a capture', () => {
    // Simulates the frame right after a capture: armed is now false, the
    // card is still sitting in frame (low motion, filled content).
    const result = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: 0,
      now: thresholds.stableDurationMs + 100,
      armed: false,
    })
    expect(result.shouldCapture).toBe(false)
    expect(result.armed).toBe(false)
  })

  it('re-arms once the card is removed (motion spike) and can capture the next card', () => {
    let state = { stableSinceTs: 0, armed: false }

    // Card lifted away: a motion spike above the re-arm threshold.
    state = evaluateStability({
      motionScore: thresholds.rearmMotionThreshold + 5,
      contentScore: 0,
      stableSinceTs: state.stableSinceTs,
      now: 1000,
      armed: state.armed,
    })
    expect(state.shouldCapture).toBe(false)
    expect(state.armed).toBe(true)
    expect(state.stableSinceTs).toBeNull()

    // New card settles into frame.
    state = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: state.stableSinceTs,
      now: 1000,
      armed: state.armed,
    })
    expect(state.stableSinceTs).toBe(1000)

    state = evaluateStability({
      motionScore: 0,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: state.stableSinceTs,
      now: 1000 + thresholds.stableDurationMs,
      armed: state.armed,
    })
    expect(state.shouldCapture).toBe(true)
  })

  it('does not treat ordinary hand jitter while holding a card as a re-arm trigger', () => {
    // Motion above the "moving" threshold but below the re-arm threshold
    // (e.g. a slight wobble) should reset the stability timer without
    // re-arming a already-fired capture lock.
    const result = evaluateStability({
      motionScore: thresholds.motionThreshold + 1,
      contentScore: thresholds.contentThreshold + 5,
      stableSinceTs: 0,
      now: 1000,
      armed: false,
    })
    expect(result.armed).toBe(false)
    expect(result.stableSinceTs).toBeNull()
  })
})
