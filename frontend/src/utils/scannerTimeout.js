export const SCANNER_REQUEST_TIMEOUT_OPTIONS = [30, 60, 120, 180]
export const DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS = SCANNER_REQUEST_TIMEOUT_OPTIONS[0]

export const scannerTestRequestTimeoutMs = (seconds) => {
  const selected = SCANNER_REQUEST_TIMEOUT_OPTIONS.includes(Number(seconds))
    ? Number(seconds)
    : DEFAULT_SCANNER_REQUEST_TIMEOUT_SECONDS
  // The backend may retry a transient provider request three times. Keep the
  // browser alive slightly longer so its generic 30-second limit cannot abort
  // a valid slow-model test before the backend reaches its own bounded result.
  return (selected * 3 + 10) * 1000
}
