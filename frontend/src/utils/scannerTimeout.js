export const SCANNER_REQUEST_TIMEOUT_OPTIONS = [30, 60, 120, 180]
export const DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS = SCANNER_REQUEST_TIMEOUT_OPTIONS[0]

const normalizedScannerRequestTimeout = (seconds) => (
  SCANNER_REQUEST_TIMEOUT_OPTIONS.includes(Number(seconds))
    ? Number(seconds)
    : DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS
)

export const scannerTestRequestTimeoutMs = (seconds) => {
  const selected = normalizedScannerRequestTimeout(seconds)
  // The capability test can make a three-attempt multi-image request followed
  // by a three-attempt single-image fallback. Cover the backend's complete
  // bounded flow rather than letting Axios abandon a result first.
  return (selected * 6 + 10) * 1000
}

export const scannerRecognitionRequestTimeoutMs = (seconds) => {
  const selected = normalizedScannerRequestTimeout(seconds)
  // A synchronous legacy/API scan can use three extraction attempts and two
  // visual-verification attempts. The extra 90 seconds covers bounded TCGdex
  // searches, reference downloads, retry backoff, and database work.
  return (selected * 5 + 90) * 1000
}
