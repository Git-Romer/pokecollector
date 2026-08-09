export const SCAN_JOBS_QUERY_KEY = ['scan-jobs']

export const isScanJobActive = job => Number(job?.active || 0) > 0

export const scanJobPollInterval = (job, intervalMs = 3000) =>
  isScanJobActive(job) ? intervalMs : false

export const scanAttentionCount = (jobs = []) =>
  jobs.reduce((total, job) => total + Number(job?.attention || 0), 0)

export const hasActiveScanJobs = (jobs = []) => jobs.some(isScanJobActive)
