import re

HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")

RESERVED_HANDLES = {
    "admin", "api", "u", "settings", "login", "logout", "static", "assets",
    "public", "profile", "me", "null", "undefined", "app", "www",
}


class HandleError(ValueError):
    pass


def validate_handle(raw: str) -> str:
    """Normalize and validate a public handle. Return the normalized handle or raise HandleError."""
    handle = (raw or "").strip().lower()
    if not handle:
        raise HandleError("Handle is required")
    if len(handle) < 3 or len(handle) > 30:
        raise HandleError("Handle must be 3–30 characters")
    if "--" in handle:
        raise HandleError("Handle cannot contain consecutive hyphens")
    if not HANDLE_RE.match(handle):
        raise HandleError("Handle may use lowercase letters, numbers and hyphens, and cannot start or end with a hyphen")
    if handle in RESERVED_HANDLES:
        raise HandleError("That handle is reserved")
    return handle
