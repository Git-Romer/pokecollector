"""Low-level async OpenID Connect provider adapter.

This module uses maintained Authlib primitives directly (discovery, code
exchange and ID-token validation) instead of Starlette session middleware or
the ``authorize_redirect``/``authorize_access_token`` convenience methods.
All browser binding, state, nonce and PKCE material is owned by the
database-backed transaction service (``services.oidc_transactions``); nothing
here stores or logs tokens, codes or provider secrets.

Only validated identity claims are returned: the exact issuer, the subject,
and optional display-oriented claims used to derive a local username. Email is
deliberately never read, returned or used for account matching.
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx2
from authlib.integrations.base_client import BaseApp, OAuthError
from authlib.integrations.base_client.async_app import AsyncOAuth2Mixin
from authlib.integrations.base_client.async_openid import AsyncOpenIDMixin
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.oidc.core import CodeIDToken
from joserfc.errors import JoseError

from services import auth_policy
from services.auth_policy import OidcConfig

# Fixed asymmetric allowlist. Provider metadata may narrow this, never widen it.
ALLOWED_ID_TOKEN_ALGORITHMS = ("RS256", "ES256")

# One finite budget per HTTP operation, applied to connect/read/write/pool.
MAX_HTTP_TIMEOUT_SECONDS = 10.0
DEFAULT_HTTP_TIMEOUT_SECONDS = 5.0

# Metadata and JWKS are cached for at most five minutes. Recreating the scoped
# adapter after this window refreshes both (Authlib caches JWKS on the app).
METADATA_CACHE_SECONDS = 300.0

OIDC_SCOPE = "openid profile"
_TOKEN_VALIDATION_LEEWAY_SECONDS = 60
_LINK_AUTH_TIME_MAX_AGE_SECONDS = 300
_LINK_AUTH_TIME_FUTURE_SKEW_SECONDS = 60
_MAX_SUBJECT_LENGTH = 255
_MAX_PROFILE_CLAIM_LENGTH = 256

_DISCOVERY_PATH = "/.well-known/openid-configuration"

# Authlib's low-level authorization-request helper logs the raw PKCE verifier at
# DEBUG from ``authlib.integrations.base_client.sync_app`` (the async mixin calls
# the same helper). Redact it at the logging boundary for *any* supplied
# verifier, independent of the logger's configured level.
_AUTHLIB_SYNC_LOGGER = "authlib.integrations.base_client.sync_app"
_REDACTED_LOG_VALUE = "[REDACTED]"
_SECRET_LOG_PATTERNS = (
    re.compile(r"(Using code_verifier:\s*).*", re.DOTALL),
    re.compile(r"(Fetch request token:\s*).*", re.DOTALL),
)


class _AuthlibSecretRedactionFilter(logging.Filter):
    """Strip secret-bearing values from Authlib's DEBUG records."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - never let logging break auth
            return True
        redacted = message
        for pattern in _SECRET_LOG_PATTERNS:
            redacted = pattern.sub(r"\1" + _REDACTED_LOG_VALUE, redacted)
        if redacted != message:
            # The message is already an f-string, so args are normally empty;
            # clear them anyway so handlers format the redacted text only.
            record.msg = redacted
            record.args = ()
        return True


def _install_authlib_log_redaction() -> None:
    """Install the targeted Authlib log filter once per process."""
    logger = logging.getLogger(_AUTHLIB_SYNC_LOGGER)
    if not any(
        isinstance(existing, _AuthlibSecretRedactionFilter)
        for existing in logger.filters
    ):
        logger.addFilter(_AuthlibSecretRedactionFilter())


_install_authlib_log_redaction()


class OidcProviderError(RuntimeError):
    """Base error for provider/configuration failures.

    ``code`` is an allowlisted, non-secret machine code that route handlers may
    map to a generic user-facing message. Messages never contain tokens, codes,
    client secrets or raw provider responses.
    """

    code = "oidc_error"


class OidcConfigurationError(OidcProviderError):
    code = "configuration_error"


class OidcDiscoveryError(OidcProviderError):
    code = "provider_unavailable"


class OidcTokenExchangeError(OidcProviderError):
    code = "provider_error"


class OidcTokenValidationError(OidcProviderError):
    code = "invalid_identity"


class OidcFreshAuthenticationError(OidcProviderError):
    code = "reauth_required"


@dataclass(frozen=True)
class OidcIdentity:
    """Validated identity claims from an ID token (no provider tokens)."""

    issuer: str
    subject: str
    auth_time: int | None = None
    preferred_username: str | None = None
    name: str | None = None


@dataclass(frozen=True)
class AuthorizationRequest:
    """Authorization URL plus the secrets the transaction store must persist."""

    url: str
    state: str
    nonce: str
    code_verifier: str


class _OidcClientApp(AsyncOAuth2Mixin, AsyncOpenIDMixin, BaseApp):
    """Minimal Authlib app: no framework session/state integration."""

    client_cls = AsyncOAuth2Client

    async def _on_update_token(self, token, refresh_token=None, access_token=None):
        # Provider tokens are validated and discarded; never persist or log them.
        return None


class OidcProvider:
    """Discovery/code-exchange/ID-token adapter for one configured issuer."""

    def __init__(
        self,
        config: OidcConfig,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ):
        if not isinstance(timeout_seconds, (int, float)) or isinstance(
            timeout_seconds, bool
        ):
            raise OidcConfigurationError("OIDC HTTP timeout must be a number")
        timeout_seconds = float(timeout_seconds)
        if not timeout_seconds > 0 or timeout_seconds > MAX_HTTP_TIMEOUT_SECONDS:
            raise OidcConfigurationError(
                "OIDC HTTP timeout must be finite and at most "
                f"{MAX_HTTP_TIMEOUT_SECONDS:g} seconds"
            )

        self.config = config
        self._transport = transport
        self._clock = clock
        self._timeout_seconds = timeout_seconds
        self._timeout = httpx2.Timeout(
            connect=timeout_seconds,
            read=timeout_seconds,
            write=timeout_seconds,
            pool=timeout_seconds,
        )
        self._app: _OidcClientApp | None = None
        self._metadata: dict[str, Any] | None = None
        self._metadata_loaded_at: float | None = None

        # Revalidate operator-supplied URLs with the shared policy rules so a
        # directly constructed config cannot bypass startup validation.
        try:
            auth_policy._validate_url("OIDC_ISSUER_URL", config.issuer_url)
            redirect = auth_policy._validate_url(
                "OIDC_REDIRECT_URI", config.redirect_uri
            )
        except auth_policy.AuthConfigError as exc:
            raise OidcConfigurationError(str(exc)) from None
        if redirect.path != auth_policy.OIDC_CALLBACK_PATH:
            raise OidcConfigurationError(
                "OIDC_REDIRECT_URI must point at the exact callback path"
            )
        if not config.client_id or not config.client_secret:
            raise OidcConfigurationError(
                "OIDC client ID and client secret are required"
            )

    # ------------------------------------------------------------------
    # Discovery and cache
    # ------------------------------------------------------------------
    @property
    def discovery_url(self) -> str:
        return self.config.issuer_url.rstrip("/") + _DISCOVERY_PATH

    async def _get_app(self) -> _OidcClientApp:
        now = self._clock()
        if (
            self._app is None
            or self._metadata_loaded_at is None
            or now - self._metadata_loaded_at >= METADATA_CACHE_SECONDS
        ):
            metadata = await self._fetch_metadata()
            self._app = self._build_app(metadata)
            self._metadata = metadata
            self._metadata_loaded_at = now
        return self._app

    def _build_app(self, metadata: dict[str, Any]) -> _OidcClientApp:
        client_kwargs: dict[str, Any] = {
            "timeout": self._timeout,
            "follow_redirects": False,
            "code_challenge_method": "S256",
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport

        app = _OidcClientApp(
            None,
            name="oidc",
            client_id=self.config.client_id,
            client_secret=self.config.client_secret,
            client_kwargs=client_kwargs,
        )
        # Discovery is fetched and validated here, so pre-seed Authlib's
        # metadata cache instead of letting it perform its own uncapped fetch.
        app.server_metadata = dict(metadata)
        app.server_metadata["_loaded_at"] = self._clock()
        return app

    async def _fetch_metadata(self) -> dict[str, Any]:
        try:
            async with httpx2.AsyncClient(
                timeout=self._timeout,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.get(self.discovery_url)
        except (httpx2.HTTPError, OSError, ValueError):
            raise OidcDiscoveryError(
                "Could not load OpenID Connect discovery metadata"
            ) from None

        if response.status_code != 200:
            raise OidcDiscoveryError(
                "OpenID Connect discovery returned an unexpected status"
            )
        try:
            metadata = response.json()
        except ValueError:
            raise OidcDiscoveryError(
                "OpenID Connect discovery did not return JSON"
            ) from None
        if not isinstance(metadata, dict):
            raise OidcDiscoveryError(
                "OpenID Connect discovery did not return a JSON object"
            )

        if metadata.get("issuer") != self.config.issuer_url:
            raise OidcConfigurationError(
                "OpenID Connect discovery issuer does not exactly match "
                "OIDC_ISSUER_URL"
            )

        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            value = metadata.get(key)
            if not isinstance(value, str) or not value:
                raise OidcConfigurationError(
                    f"OpenID Connect discovery is missing {key}"
                )
            try:
                auth_policy._validate_url(key, value)
            except auth_policy.AuthConfigError as exc:
                raise OidcConfigurationError(str(exc)) from None

        advertised = metadata.get("id_token_signing_alg_values_supported")
        if not isinstance(advertised, (list, tuple)) or not all(
            isinstance(alg, str) for alg in advertised
        ):
            raise OidcConfigurationError(
                "OpenID Connect provider does not advertise ID-token signing "
                "algorithms"
            )
        allowed = [
            alg for alg in ALLOWED_ID_TOKEN_ALGORITHMS if alg in set(advertised)
        ]
        if not allowed:
            raise OidcConfigurationError(
                "OpenID Connect provider does not support RS256 or ES256 ID tokens"
            )
        # Authlib reads this list when verifying tokens, so only the validated
        # asymmetric intersection is ever visible to the library.
        metadata["id_token_signing_alg_values_supported"] = allowed

        auth_methods = metadata.get("token_endpoint_auth_methods_supported")
        if auth_methods is not None:
            if not isinstance(auth_methods, (list, tuple)) or not all(
                isinstance(method, str) for method in auth_methods
            ):
                raise OidcConfigurationError(
                    "OpenID Connect provider advertises invalid token endpoint "
                    "authentication methods"
                )
            # RFC 8414 defaults to client_secret_basic when the field is absent.
            if "client_secret_basic" not in auth_methods:
                raise OidcConfigurationError(
                    "OpenID Connect provider does not support client_secret_basic"
                )

        # Only pass fields Authlib actually needs. Metadata is provider-controlled
        # and Authlib forwards these keys as HTTP client kwargs, so unrelated
        # keys (e.g. verify/timeout/headers) must never reach the transport.
        return {
            "issuer": metadata["issuer"],
            "authorization_endpoint": metadata["authorization_endpoint"],
            "token_endpoint": metadata["token_endpoint"],
            "jwks_uri": metadata["jwks_uri"],
            "id_token_signing_alg_values_supported": allowed,
        }

    # ------------------------------------------------------------------
    # Authorization request
    # ------------------------------------------------------------------
    async def build_authorization_url(
        self,
        *,
        state: str | None = None,
        nonce: str | None = None,
        code_verifier: str | None = None,
        prompt: str | None = None,
        max_age: int | None = None,
    ) -> AuthorizationRequest:
        """Build an authorization-code request with PKCE S256."""
        # Re-assert the redaction filter in case application logging was
        # reconfigured (dictConfig replaces filters) after this module imported.
        _install_authlib_log_redaction()
        app = await self._get_app()
        state = state or secrets.token_urlsafe(32)
        nonce = nonce or secrets.token_urlsafe(32)
        code_verifier = code_verifier or secrets.token_urlsafe(64)

        kwargs: dict[str, Any] = {
            "scope": OIDC_SCOPE,
            "state": state,
            "nonce": nonce,
            "code_verifier": code_verifier,
        }
        if prompt is not None:
            kwargs["prompt"] = prompt
        if max_age is not None:
            kwargs["max_age"] = int(max_age)

        try:
            result = await app.create_authorization_url(
                self.config.redirect_uri, **kwargs
            )
        except (RuntimeError, ValueError, TypeError) as exc:
            raise OidcConfigurationError(
                "Could not build the OpenID Connect authorization request"
            ) from None

        if not isinstance(result, dict) or not result.get("url"):
            raise OidcConfigurationError(
                "OpenID Connect provider did not return an authorization URL"
            )
        return AuthorizationRequest(
            url=result["url"],
            state=state,
            nonce=nonce,
            code_verifier=code_verifier,
        )

    # ------------------------------------------------------------------
    # Callback exchange and validation
    # ------------------------------------------------------------------
    async def exchange_code_for_identity(
        self,
        *,
        code: str,
        code_verifier: str,
        nonce: str,
        require_fresh_auth: bool = False,
    ) -> OidcIdentity:
        """Exchange an authorization code and return only validated claims.

        Any provider, transport or validation failure is mapped to a generic
        :class:`OidcProviderError` subclass; tokens, codes and provider error
        descriptions are never included in the raised message.
        """
        if not code or not code_verifier or not nonce:
            raise OidcTokenExchangeError("Authorization code exchange failed")

        app = await self._get_app()
        try:
            token = await app.fetch_access_token(
                redirect_uri=self.config.redirect_uri,
                code=code,
                code_verifier=code_verifier,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            raise OidcTokenExchangeError(
                "Authorization code exchange failed"
            ) from None

        if not isinstance(token, dict) or not token.get("id_token"):
            raise OidcTokenValidationError(
                "Authorization response did not include an ID token"
            )
        return await self._validate_id_token(
            app, token, nonce=nonce, require_fresh_auth=require_fresh_auth
        )

    async def _validate_id_token(
        self,
        app: _OidcClientApp,
        token: dict[str, Any],
        *,
        nonce: str,
        require_fresh_auth: bool,
    ) -> OidcIdentity:
        # Explicit essential claims: issuer exact, audience is this client,
        # numeric exp/iat, a subject and the nonce from this transaction.
        # Authlib additionally enforces azp (present => equal to client id;
        # required for multi-audience tokens) and signature/algorithm.
        claims_options = {
            "iss": {"essential": True, "value": self.config.issuer_url},
            "aud": {"essential": True, "value": self.config.client_id},
            "exp": {"essential": True},
            "iat": {"essential": True},
            "sub": {"essential": True},
            "nonce": {"essential": True},
        }
        try:
            claims = await app.parse_id_token(
                token,
                nonce=nonce,
                claims_options=claims_options,
                claims_cls=CodeIDToken,
                leeway=_TOKEN_VALIDATION_LEEWAY_SECONDS,
            )
        except asyncio.CancelledError:
            raise
        except (OAuthError, JoseError, httpx2.HTTPError, OSError, ValueError, TypeError, KeyError, RuntimeError):
            raise OidcTokenValidationError("ID token validation failed") from None

        if claims is None:
            raise OidcTokenValidationError("ID token validation failed")

        issuer = claims.get("iss")
        subject = claims.get("sub")
        if not isinstance(issuer, str) or issuer != self.config.issuer_url:
            raise OidcTokenValidationError("ID token issuer does not match")
        if (
            not isinstance(subject, str)
            or not subject
            or len(subject) > _MAX_SUBJECT_LENGTH
        ):
            raise OidcTokenValidationError("ID token subject is invalid")

        # When present, azp must be the exact configured client id -- including
        # empty, null or boolean values. Authlib only enforces this for
        # multi-audience tokens, so validate the claim explicitly here too.
        if "azp" in claims:
            authorized_party = claims.get("azp")
            if (
                not isinstance(authorized_party, str)
                or authorized_party != self.config.client_id
            ):
                raise OidcTokenValidationError(
                    "ID token authorized party is invalid"
                )

        auth_time = self._validated_auth_time(claims)
        if require_fresh_auth:
            self._require_fresh_auth_time(auth_time)

        return OidcIdentity(
            issuer=issuer,
            subject=subject,
            auth_time=auth_time,
            preferred_username=_profile_claim(claims, "preferred_username"),
            name=_profile_claim(claims, "name"),
        )

    def _validated_auth_time(self, claims: Any) -> int | None:
        value = claims.get("auth_time")
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise OidcTokenValidationError("ID token auth_time is invalid")
        # Reject NaN and +/-inf before int() can raise an unmapped error.
        if isinstance(value, float) and not math.isfinite(value):
            raise OidcTokenValidationError("ID token auth_time is invalid")
        if value < 0 or value != int(value):
            raise OidcTokenValidationError("ID token auth_time is invalid")
        return int(value)

    def _require_fresh_auth_time(self, auth_time: int | None) -> None:
        if auth_time is None:
            raise OidcFreshAuthenticationError(
                "Provider did not confirm a fresh authentication"
            )
        now = int(self._clock())
        if auth_time > now + _LINK_AUTH_TIME_FUTURE_SKEW_SECONDS:
            raise OidcFreshAuthenticationError(
                "Provider authentication time is in the future"
            )
        if now - auth_time > _LINK_AUTH_TIME_MAX_AGE_SECONDS:
            raise OidcFreshAuthenticationError(
                "Provider authentication is not recent enough"
            )


def _profile_claim(claims: Any, name: str) -> str | None:
    value = claims.get(name)
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > _MAX_PROFILE_CLAIM_LENGTH:
        return None
    return value
