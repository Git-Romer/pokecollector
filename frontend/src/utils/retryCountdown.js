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

export function formatRetryCountdown(nextAttemptAt, t, nowMs = Date.now(), retryReason = null) {
  const parts = retryCountdownParts(nextAttemptAt, nowMs)
  if (!parts) return retryReason === 'daily_quota'
    ? t('scanner.dailyQuotaWaiting')
    : t('scanner.itemRetrying')
  let countdown
  if (parts.unit === 'seconds') {
    countdown = t('scanner.retryingInSeconds').replace('{seconds}', parts.seconds)
  } else if (parts.unit === 'minutes') {
    countdown = t('scanner.retryingInMinutes').replace('{minutes}', parts.minutes)
  } else {
    countdown = t('scanner.retryingInHours')
      .replace('{hours}', parts.hours)
      .replace('{minutes}', parts.minutes)
  }
  return retryReason === 'daily_quota'
    ? t('scanner.dailyQuotaRetry').replace('{countdown}', countdown)
    : countdown
}
