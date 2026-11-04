"""Authentication-mode and OIDC configuration policy.

This module is the single source of truth for the deployment's authentication
mode (``AUTH_MODE=local|mixed|oidc-only``) and for syntactic validation of the
OIDC client configuration. It performs no database access and no provider
network access: startup calls :func:`validate_startup_auth_config` before any
database mutation, and request handlers derive their gates from
:func:`load_auth_policy`.

The policy rules (see the approved security contract):

* ``local`` (default when unset/blank) keeps the legacy password behaviour;
  OIDC endpoints are disabled and stray ``OIDC_*`` variables are ignored.
* ``mixed`` and ``oidc-only`` require a valid confidential OIDC client and
  always require authentication, regardless of the stored multi-user setting or
  number of users. ``USER_MODE=single`` conflicts with both and is a startup
  error.
* ``oidc-only`` additionally disables password login and HTTP password changes.

This is authentication-method policy, not session revocation: application JWTs
issued before a mode change remain valid until they expire or their user is
deactivated. Logout likewise stays local rather than becoming IdP logout.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit

AUTH_MODE_LOCAL = "local"
AUTH_MODE_MIXED = "mixed"
AUTH_MODE_OIDC_ONLY = "oidc-only"

AUTH_MODES = (AUTH_MODE_LOCAL, AUTH_MODE_MIXED, AUTH_MODE_OIDC_ONLY)

OIDC_CALLBACK_PATH = "/api/auth/oidc/callback"
DEFAULT_OIDC_DISPLAY_NAME = "Single sign-on"

# Literal loopback development hosts, per the contract. Anything else must use HTTPS.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_DEFAULT_PORTS = {"http": 80, "https": 443}


class AuthConfigError(RuntimeError):
    """Invalid authentication configuration.

    Startup must abort when this is raised. Messages name the offending
    variable and the rule, never a secret value.
    """


@dataclass(frozen=True)
class OidcConfig:
    """Validated OIDC client settings for the single configured issuer."""

    issuer_url: str
    client_id: str
    # Never include the secret in repr()/logs by accident.
    client_secret: str = field(repr=False)
    redirect_uri: str
    display_name: str = DEFAULT_OIDC_DISPLAY_NAME

    @property
    def app_origin(self) -> str:
        """Trusted application origin, derived only from the configured redirect URI."""
        parts = urlsplit(self.redirect_uri)
        host = (parts.hostname or "").lower()
        if ":" in host:
            # urlsplit exposes IPv6 literals without their brackets; rebuild a
            # canonical origin so it compares correctly with browser Origin values.
            host = f"[{host}]"
        port = parts.port
        origin = f"{parts.scheme.lower()}://{host}"
        if port is not None and port != _DEFAULT_PORTS.get(parts.scheme.lower()):
            origin = f"{origin}:{port}"
        return origin


@dataclass(frozen=True)
class AuthPolicy:
    """Resolved authentication policy for the current deployment."""

    auth_mode: str
    oidc: OidcConfig | None

    @property
    def authentication_required(self) -> bool:
        """OIDC-enabled modes always require a login, ignoring user count/settings."""
        return self.auth_mode != AUTH_MODE_LOCAL

    @property
    def password_login_enabled(self) -> bool:
        return self.auth_mode != AUTH_MODE_OIDC_ONLY

    @property
    def password_management_enabled(self) -> bool:
        """Whether HTTP password login/change endpoints may set or use a password."""
        return self.password_login_enabled

    @property
    def oidc_enabled(self) -> bool:
        return self.oidc is not None

    @property
    def oidc_display_name(self) -> str | None:
        return self.oidc.display_name if self.oidc is not None else None

    @property
    def mode_locked(self) -> bool:
        """True when AUTH_MODE pins authentication on, so user mode cannot be toggled."""
        return self.authentication_required

    def capabilities(self, *, multi_user: bool, locked: bool) -> dict:
        """Safe public capability payload for ``GET /api/auth/mode``.

        Contains no credentials or provider token material. OIDC-enabled modes
        always report an enforced login and a locked mode, even if a stale
        caller computed otherwise.
        """
        return {
            "multi_user": True if self.authentication_required else multi_user,
            "locked": True if self.mode_locked else locked,
            "auth_mode": self.auth_mode,
            "password_login_enabled": self.password_login_enabled,
            "oidc_enabled": self.oidc_enabled,
            "oidc_display_name": self.oidc_display_name,
        }


def resolve_auth_mode(raw: str | None = None) -> str:
    """Return the validated AUTH_MODE. Unset/blank means local for Compose compatibility."""
    value = os.getenv("AUTH_MODE", "") if raw is None else raw
    value = (value or "").strip()
    if not value:
        return AUTH_MODE_LOCAL
    normalized = value.lower()
    if normalized not in AUTH_MODES:
        raise AuthConfigError(
            "AUTH_MODE must be one of 'local', 'mixed' or 'oidc-only' "
            "(unset or blank means 'local')"
        )
    return normalized


def load_auth_policy() -> AuthPolicy:
    """Resolve the effective policy from the environment.

    In local mode the OIDC variables are deliberately not read or validated:
    stray provider configuration must not activate OIDC or fail startup.
    """
    auth_mode = resolve_auth_mode()
    if auth_mode == AUTH_MODE_LOCAL:
        return AuthPolicy(auth_mode=auth_mode, oidc=None)
    return AuthPolicy(auth_mode=auth_mode, oidc=_load_oidc_config())


def validate_startup_auth_config(*, user_mode: str | None = None) -> AuthPolicy:
    """Fail-fast startup validation of authentication configuration.

    ``user_mode`` is the parsed USER_MODE override (``"single"``/``"multi"``/None),
    supplied by the caller so this module does not duplicate USER_MODE logging.
    Raises :class:`AuthConfigError` when startup must abort.
    """
    policy = load_auth_policy()
    if policy.authentication_required and user_mode == "single":
        raise AuthConfigError(
            f"USER_MODE=single conflicts with AUTH_MODE={policy.auth_mode}: "
            "authentication is mandatory whenever OIDC is enabled. "
            "Unset USER_MODE (or use USER_MODE=multi)."
        )
    return policy


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise AuthConfigError(
            f"{name} is required when AUTH_MODE is '{AUTH_MODE_MIXED}' or '{AUTH_MODE_OIDC_ONLY}'"
        )
    return value


def _load_oidc_config() -> OidcConfig:
    issuer_url = _required_env("OIDC_ISSUER_URL")
    client_id = _required_env("OIDC_CLIENT_ID")
    client_secret = _required_env("OIDC_CLIENT_SECRET")
    redirect_uri = _required_env("OIDC_REDIRECT_URI")

    _validate_url("OIDC_ISSUER_URL", issuer_url)
    redirect = _validate_url("OIDC_REDIRECT_URI", redirect_uri)
    if redirect.path != OIDC_CALLBACK_PATH:
        raise AuthConfigError(
            f"OIDC_REDIRECT_URI must point at the exact path {OIDC_CALLBACK_PATH}"
        )

    display_name = (os.getenv("OIDC_DISPLAY_NAME") or "").strip() or DEFAULT_OIDC_DISPLAY_NAME

    return OidcConfig(
        issuer_url=issuer_url,
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        display_name=display_name,
    )


def _validate_url(name: str, value: str):
    """Validate an operator-configured absolute URL; return its parsed parts."""
    if any(ch.isspace() for ch in value):
        raise AuthConfigError(f"{name} must not contain whitespace")
    try:
        # urlsplit rejects malformed IPv6/bracket syntax itself.
        parts = urlsplit(value)
        authority = parts.netloc.rsplit("@", 1)[-1]
        port = parts.port
    except ValueError:
        raise AuthConfigError(f"{name} is not a valid absolute URL") from None
    if not parts.scheme or not parts.netloc:
        raise AuthConfigError(f"{name} must be an absolute URL")
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise AuthConfigError(f"{name} must use http or https")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise AuthConfigError(f"{name} must not contain credentials")
    if parts.query or parts.fragment:
        raise AuthConfigError(f"{name} must not contain a query string or fragment")
    if authority.endswith(":"):
        raise AuthConfigError(f"{name} has an empty port")
    if port == 0:
        raise AuthConfigError(f"{name} has an invalid port")
    hostname = parts.hostname
    if not hostname:
        raise AuthConfigError(f"{name} must include a hostname")
    if scheme != "https" and hostname.lower() not in _LOOPBACK_HOSTS:
        raise AuthConfigError(
            f"{name} must use HTTPS (plain HTTP is allowed only for loopback development)"
        )
    return parts
