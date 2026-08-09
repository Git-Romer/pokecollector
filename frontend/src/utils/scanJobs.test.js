import { describe, expect, it } from 'vitest'
import {
  hasActiveScanJobs,
  isScanJobActive,
  scanAttentionCount,
  scanJobPollInterval,
} from './scanJobs'

describe('scan job presentation helpers', () => {
  it('treats only work in progress as active', () => {
    expect(isScanJobActive({ active: 2 })).toBe(true)
    expect(isScanJobActive({ active: 0, attention: 4 })).toBe(false)
  })

  it('polls active jobs and stops for completed jobs', () => {
    expect(scanJobPollInterval({ active: 1 })).toBe(3000)
    expect(scanJobPollInterval({ active: 0 })).toBe(false)
  })

  it('counts only actionable results for badges', () => {
    expect(scanAttentionCount([{ attention: 3 }, { attention: 2 }, { active: 50 }])).toBe(5)
  })

  it('detects active jobs across the inbox', () => {
    expect(hasActiveScanJobs([{ active: 0 }, { active: 1 }])).toBe(true)
    expect(hasActiveScanJobs([{ active: 0 }])).toBe(false)
  })
})
