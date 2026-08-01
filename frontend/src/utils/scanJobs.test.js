import { describe, expect, it } from 'vitest'
import { isJobActive, jobPollInterval, outstandingScanCount } from './scanJobs'

describe('isJobActive', () => {
  it('treats queued and running jobs as active', () => {
    expect(isJobActive({ status: 'pending', pending: 0 })).toBe(true)
    expect(isJobActive({ status: 'running', pending: 0 })).toBe(true)
  })

  it('stays active while items are still waiting, even once the job says done', () => {
    // Items that exhausted a drain pass go back to pending for a later one, so
    // a "done" job with outstanding items must keep polling.
    expect(isJobActive({ status: 'done', pending: 2 })).toBe(true)
  })

  it('is inactive for a finished or failed job with nothing outstanding', () => {
    expect(isJobActive({ status: 'done', pending: 0 })).toBe(false)
    expect(isJobActive({ status: 'failed', pending: 0 })).toBe(false)
  })

  it('handles a missing job', () => {
    expect(isJobActive(null)).toBe(false)
    expect(isJobActive(undefined)).toBe(false)
  })
})

describe('jobPollInterval', () => {
  it('polls while work is outstanding', () => {
    expect(jobPollInterval({ status: 'running', pending: 1 })).toBe(3000)
  })

  it('stops polling a finished job rather than hitting the API forever', () => {
    expect(jobPollInterval({ status: 'done', pending: 0 })).toBe(false)
  })

  it('honours a custom interval', () => {
    expect(jobPollInterval({ status: 'running', pending: 1 }, 500)).toBe(500)
  })
})

describe('outstandingScanCount', () => {
  it('sums unresolved items across jobs', () => {
    expect(outstandingScanCount([{ unresolved: 3 }, { unresolved: 2 }])).toBe(5)
  })

  it('is zero once everything has been reviewed, so the badge clears', () => {
    expect(outstandingScanCount([{ unresolved: 0 }, { unresolved: 0 }])).toBe(0)
  })

  it('tolerates missing counts and an empty list', () => {
    expect(outstandingScanCount([])).toBe(0)
    expect(outstandingScanCount()).toBe(0)
    expect(outstandingScanCount([{}, { unresolved: 1 }])).toBe(1)
  })
})
