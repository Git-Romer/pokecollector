function parseUtcTimestamp(value) {
  if (!value) return Number.NaN
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`
  return Date.parse(normalized)
}

export function retryCountdownParts(nextAttemptAt, nowMs = Date.now()) {
  const retryAtMs = parseUtcTimestamp(nextAttemptAt)
  if (!Number.isFinite(retryAtMs)) return null

  const remainingMs = Math.max(0, retryAtMs - nowMs)
  if (remainingMs < 60_000) {
    return { unit: 'seconds', seconds: Math.ceil(remainingMs / 1000) }
  }
  if (remainingMs < 60 * 60_000) {
    return { unit: 'minutes', minutes: Math.ceil(remainingMs / 60_000) }
  }

  const totalMinutes = Math.ceil(remainingMs / 60_000)
  return {
    unit: 'hours',
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  }
}

export function formatRetryCountdown(nextAttemptAt, t, nowMs = Date.now()) {
  const parts = retryCountdownParts(nextAttemptAt, nowMs)
  if (!parts) return t('scanner.itemRetrying')
  if (parts.unit === 'seconds') {
    return t('scanner.retryingInSeconds').replace('{seconds}', parts.seconds)
  }
  if (parts.unit === 'minutes') {
    return t('scanner.retryingInMinutes').replace('{minutes}', parts.minutes)
  }
  return t('scanner.retryingInHours')
    .replace('{hours}', parts.hours)
    .replace('{minutes}', parts.minutes)
}
