"""Access-log redaction for OIDC requests.

The OIDC callback receives a one-time authorization ``code`` and ``state`` in its
query string. Uvicorn's access log records the full request target (path plus
query), so the application keeps normal access logging enabled and strips the
query string only for OIDC paths at the logging boundary.

The filter rewrites ``record.args`` (``uvicorn.access`` logs
``'%s - "%s %s HTTP/%s" %d'`` with the path-with-query as the third argument)
instead of mutating handler configuration, so every handler and formatter keeps
working and non-OIDC requests are logged unchanged. It never inspects headers,
cookies or bodies.
"""
import logging

# Only paths below this prefix are rewritten; the OIDC routes never take a
# meaningful query string except the callback's one-time code/state.
OIDC_LOG_PATH_PREFIX = "/api/auth/oidc"

# uvicorn's access record: ("%s - \"%s %s HTTP/%s\" %d", client, method, path, version, status)
_PATH_ARG_INDEX = 2

_ACCESS_LOGGER = "uvicorn.access"


def _redact_path(value: str) -> str:
    """Return the path without its query string for OIDC requests only."""
    if not isinstance(value, str):
        return value
    # Match the OIDC route boundary exactly; a sibling path such as
    # /api/auth/oidcish must keep its full target.
    if value != OIDC_LOG_PATH_PREFIX and not value.startswith(
        OIDC_LOG_PATH_PREFIX + "/"
    ):
        return value
    path, separator, _query = value.partition("?")
    if not separator:
        return value
    return path


class OidcAccessLogRedactionFilter(logging.Filter):
    """Strip the query string from OIDC request targets in access records."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            args = record.args
            if isinstance(args, tuple) and len(args) > _PATH_ARG_INDEX:
                path = args[_PATH_ARG_INDEX]
                redacted = _redact_path(path)
                if redacted != path:
                    new_args = list(args)
                    new_args[_PATH_ARG_INDEX] = redacted
                    record.args = tuple(new_args)
        except Exception:  # pragma: no cover - never let logging break a request
            return True
        return True


def install_oidc_access_log_redaction() -> None:
    """Install the filter once per process on uvicorn's access logger."""
    logger = logging.getLogger(_ACCESS_LOGGER)
    if not any(
        isinstance(existing, OidcAccessLogRedactionFilter)
        for existing in logger.filters
    ):
        logger.addFilter(OidcAccessLogRedactionFilter())


install_oidc_access_log_redaction()
