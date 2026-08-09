export const SCAN_JOBS_QUERY_KEY = ['scan-jobs']

// A job still doing work: either the worker hasn't finished it, or it has
// finished but items are waiting to be recognized on a later drain pass.
export const isJobActive = (job) =>
  !!job && (job.status === 'pending' || job.status === 'running' || job.pending > 0)

// Poll only while there is something to wait for — a finished job's detail
// view should not keep hitting the API.
export const jobPollInterval = (job, intervalMs = 3000) =>
  isJobActive(job) ? intervalMs : false

// What the nav badge counts: cards recognized but not yet reviewed, plus
// anything still being worked on, so the badge means "there is something here
// for you" rather than just "a job exists". Served by the API so a fully
// reviewed job stops counting.
export const outstandingScanCount = (jobs = []) =>
  jobs.reduce((total, job) => total + (job.unresolved || 0), 0)
