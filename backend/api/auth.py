import json
import logging
import os
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db, get_setting, save_setting
from models import User
from services.auth import (
    create_access_token,
    decode_token,
    has_valid_password_hash,
    hash_password,
    verify_password,
)
from services.auth_admin import (
    LastUsableAdminError,
    count_usable_admins,
    ensure_admin_transition_keeps_usable_admin,
    is_usable_admin,
    lock_admin_transitions,
)
from services.auth_policy import (
    AUTH_MODE_MIXED,
    AUTH_MODE_OIDC_ONLY,
    AuthConfigError,
    AuthPolicy,
    load_auth_policy,
)
from services.oidc_identity import (
    OidcIdentityConflictError,
    OidcProvisioningError,
    OidcUsernameTakenError,
    find_user_identity,
    provision_user_for_identity,
    provision_user_for_identity_with_username,
    resolve_identity_user,
    validated_username_hint,
)
from services.oidc_link import (
    LINK_REASON_AUTHENTICATION,
    LINK_REASON_POLICY,
    OidcLinkCompletionError,
    finalize_link_handoff,
)
from services.oidc_provider import OidcProvider, OidcProviderError
from services.oidc_transactions import (
    OPERATION_LINK,
    OPERATION_LOGIN,
    OidcTransactionError,
    claim_authorization_transaction,
    claim_handoff_transaction,
    decrypted_code_verifier,
    decrypted_nonce,
    generate_transaction_secret,
    invalidate_identity_transactions,
    invalidate_user_transactions,
    preview_handoff_transaction,
    promote_authorization_to_handoff,
    purge_expired_transactions,
    start_transaction,
)

router = APIRouter()
logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "trainer"
    avatar_id: int | None = None
    must_change_password: bool = False


class UpdateUserRequest(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None
    avatar_id: int | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForceChangePasswordRequest(BaseModel):
    new_password: str


def validate_avatar_id(avatar_id: int | None):
    if avatar_id is not None and (avatar_id < 1 or avatar_id > 151):
        raise HTTPException(status_code=400, detail="avatar_id must be 1-151")


def field_was_set(model: BaseModel, field_name: str) -> bool:
    if hasattr(model, "model_fields_set"):
        return field_name in model.model_fields_set
    return field_name in model.__fields_set__


def _sync_public_handle_for_username(db: Session, user: User, username: str) -> None:
    from services import public_profile as pp

    if not user.is_profile_public:
        user.public_handle = None
        return
    try:
        pp.assign_public_handle(db, user, trainer_name=username)
    except pp.HandleConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except pp.HandleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def env_user_mode(*, warn_invalid: bool = False) -> str | None:
    """USER_MODE pins the mode from the environment, overriding the stored setting:
    'single' forces single-user (login screen off), 'multi' forces multi-user (login on).
    Unset, blank, or unrecognised means no override. It is the recovery hatch for an admin
    locked out of multi-user mode: set USER_MODE=single, restart, regain local access, reset
    the password, then remove it. Forcing single-user disables the login screen, so that
    direction is a local/LAN recovery tool, not something to leave set on a public install."""
    raw = os.getenv("USER_MODE", "").strip().lower().replace("-", "_")
    if raw in {"single", "single_user"}:
        return "single"
    if raw in {"multi", "multi_user"}:
        return "multi"
    if raw and warn_invalid:
        logger.warning("USER_MODE=%r is not 'single' or 'multi'; ignoring it.", os.getenv("USER_MODE"))
    return None


def mode_is_env_locked() -> bool:
    """True when USER_MODE pins the mode, so the in-app toggle cannot change it."""
    return env_user_mode() is not None


def auth_policy() -> AuthPolicy:
    """Resolve AUTH_MODE policy for a request, failing closed if it is invalid.

    Startup validates the same configuration before any database mutation; this
    is defence in depth so a misconfigured process can never serve implicit-admin
    access. The exception message names only configuration variables, not values.
    """
    try:
        return load_auth_policy()
    except AuthConfigError as exc:
        logger.error("Authentication configuration is invalid: %s", exc)
        raise HTTPException(status_code=503, detail="Authentication is misconfigured") from exc


def _multi_user_enabled(db: Session, policy: AuthPolicy) -> bool:
    if policy.authentication_required:
        # Mixed/oidc-only always require authentication: ignore USER_MODE and the
        # stored setting, including a stale 'single-user' setting or user count.
        return True
    override = env_user_mode()
    if override is not None:
        return override == "multi"
    multi = get_setting("multi_user_mode")
    if multi is None:
        multi = "true" if db.query(User).count() > 1 else "false"
    return str(multi).lower() == "true"


def multi_user_enabled(db: Session) -> bool:
    """True when the login screen is enforced.

    OIDC-enabled modes always enforce it. In local mode the USER_MODE env override
    wins, then the stored setting, falling back to 'more than one user exists'.
    """
    return _multi_user_enabled(db, auth_policy())


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    # Implicit single-user admin access is a local-mode-only behaviour: in
    # mixed/oidc-only modes multi_user_enabled() is always True and this branch
    # cannot return an admin for an unauthenticated request.
    if not token:
        if not multi_user_enabled(db):
            admin = db.query(User).filter(User.role == "admin", User.is_active == True).first()
            if admin:
                return admin
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


# ---------------------------------------------------------------------------
# OIDC browser flow (start -> callback -> browser-bound completion)
# ---------------------------------------------------------------------------
#
# Route-level rate limiting below is deliberately per-process, using the same
# in-memory fixed-window pattern as the existing login counter in main.py and
# complementing the global SlowAPI default limit. It is a cheap local brake, not
# a shared multi-worker quota: a deployment exposed beyond loopback must also
# enforce a shared limit at the ingress (nginx/reverse proxy or platform edge).
# The limiter never logs request URLs, codes, states or tokens.
OIDC_BROWSER_COOKIE = "pc_oidc_browser"
OIDC_HANDOFF_COOKIE = "pc_oidc_handoff"
_OIDC_COOKIE_PATH = "/api/auth/oidc"
_OIDC_COMPLETE_PATH = "/auth/oidc/complete"
_OIDC_LOGIN_PATH = "/login"
_OIDC_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
}
_OIDC_ALLOWED_ERROR_CODES = frozenset(
    {
        "provider_denied",
        "provider_error",
        "provider_unavailable",
        "reauth_required",
        "invalid_state",
        "invalid_request",
        "restart",
    }
)

_OIDC_RATE_LIMIT_MAX = 10
_OIDC_RATE_LIMIT_WINDOW_SECONDS = 60.0
_OIDC_RATE_LIMIT_MAX_BUCKETS = 2048
_oidc_rate_state: dict[tuple[str, str], list[float]] = {}
_oidc_rate_lock = threading.Lock()


def _oidc_provider_cache_key(config) -> tuple:
    """Everything that changes the adapter's behaviour, and nothing else."""
    return (
        config.issuer_url,
        config.client_id,
        config.client_secret,
        config.redirect_uri,
        config.display_name,
    )


_oidc_provider_cache: dict[tuple, OidcProvider] = {}
_oidc_provider_cache_lock = threading.Lock()


def _build_oidc_provider(config):
    """Return the process-wide provider adapter for this configuration.

    Discovery metadata and JWKS are cached inside the adapter for a bounded
    window; building a fresh adapter per request would re-fetch both on every
    sign-in. A deployment has one configured provider, so the cache keeps only
    the active key and drops an adapter built for a previous configuration
    (for example after the issuer, client or redirect URI changed).

    Tests patch this boundary to supply a synthetic provider.
    """
    key = _oidc_provider_cache_key(config)
    with _oidc_provider_cache_lock:
        provider = _oidc_provider_cache.get(key)
        if provider is None:
            # Construction is pure validation; all network work is lazy.
            provider = OidcProvider(config)
            _oidc_provider_cache.clear()
            _oidc_provider_cache[key] = provider
        return provider


def _oidc_json(status_code: int, content: dict) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers=dict(_OIDC_SECURITY_HEADERS),
    )


def _oidc_redirect(url: str) -> RedirectResponse:
    response = RedirectResponse(url=url, status_code=302)
    response.headers.update(_OIDC_SECURITY_HEADERS)
    return response


def _oidc_error_redirect(code: str, *, secure: bool) -> RedirectResponse:
    """Redirect to the fixed login page with an allowlisted, non-reflected code."""
    if code not in _OIDC_ALLOWED_ERROR_CODES:
        code = "provider_error"
    response = _oidc_redirect(f"{_OIDC_LOGIN_PATH}?oidc_error={code}")
    _clear_oidc_cookie(response, OIDC_HANDOFF_COOKIE, secure=secure)
    return response


def _oidc_secure_cookies(redirect_uri: str) -> bool:
    """Secure only when the *configured* callback URL is HTTPS.

    Forwarded headers are deliberately not consulted: a proxy misconfiguration
    must not silently downgrade the cookie flags.
    """
    return urlsplit(redirect_uri).scheme.lower() == "https"


def _require_oidc_config(policy):
    """Narrow the policy tuple for callers that already handled the error."""
    if policy is None or policy.oidc is None:
        raise HTTPException(status_code=503, detail="Authentication is misconfigured")
    return policy.oidc


def _set_oidc_cookie(
    response,
    name: str,
    value: str,
    *,
    secure: bool,
    max_age: int | None = None,
) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        path=_OIDC_COOKIE_PATH,
        httponly=True,
        samesite="lax",
        secure=secure,
    )


def _clear_oidc_cookie(response, name: str, *, secure: bool) -> None:
    response.set_cookie(
        name,
        "",
        max_age=0,
        path=_OIDC_COOKIE_PATH,
        httponly=True,
        samesite="lax",
        secure=secure,
    )


def _oidc_policy_or_error():
    """Resolve OIDC policy, or return a generic disabled/misconfigured response."""
    try:
        policy = auth_policy()
    except HTTPException as exc:
        return None, _oidc_json(exc.status_code, {"detail": exc.detail})
    if policy.oidc is None:
        # Local mode: the capability is absent, not merely forbidden.
        return None, _oidc_json(404, {"detail": "Not found"})
    return policy, None


def _purge_expired_bounded(db: Session) -> None:
    """Bounded opportunistic cleanup; never an unbounded request-path sweep."""
    try:
        purge_expired_transactions(db, limit=100)
        db.commit()
    except Exception:
        db.rollback()
        # Never log URLs, codes, states or transaction material here.
        logger.warning("OIDC expired-transaction cleanup failed")


def _consume_oidc_rate_limit(request: Request, bucket: str) -> bool:
    """Per-process fixed-window limiter; returns False when throttled."""
    now = time.monotonic()
    client = request.client
    client_key = client.host if client is not None and client.host else "unknown"
    key = (bucket, client_key)
    with _oidc_rate_lock:
        if len(_oidc_rate_state) > _OIDC_RATE_LIMIT_MAX_BUCKETS:
            cutoff = now - _OIDC_RATE_LIMIT_WINDOW_SECONDS
            for existing_key, stamps in list(_oidc_rate_state.items()):
                if not stamps or stamps[-1] < cutoff:
                    del _oidc_rate_state[existing_key]
        stamps = [
            stamp
            for stamp in _oidc_rate_state.get(key, [])
            if now - stamp < _OIDC_RATE_LIMIT_WINDOW_SECONDS
        ]
        if len(stamps) >= _OIDC_RATE_LIMIT_MAX:
            _oidc_rate_state[key] = stamps
            return False
        stamps.append(now)
        _oidc_rate_state[key] = stamps
        return True


def _is_safe_authorization_redirect(url) -> bool:
    """Require an absolute HTTP(S) authorization URL with no credentials."""
    if not isinstance(url, str) or not url:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"} or not parts.netloc:
        return False
    if parts.username is not None or parts.password is not None:
        return False
    if parts.fragment:
        return False
    if scheme == "http":
        host = (parts.hostname or "").lower()
        if host not in {"localhost", "127.0.0.1", "::1"}:
            return False
    return True


@router.get("/oidc/start")
async def oidc_start(request: Request, db: Session = Depends(get_db)):
    """Begin a login flow and redirect to the discovered authorization endpoint."""
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    if not _consume_oidc_rate_limit(request, "start"):
        return _oidc_json(
            429, {"detail": "Too many sign-in attempts. Try again in a minute."}
        )
    _purge_expired_bounded(db)

    oidc = _require_oidc_config(policy)
    secure = _oidc_secure_cookies(oidc.redirect_uri)
    browser_secret = request.cookies.get(OIDC_BROWSER_COOKIE) or (
        generate_transaction_secret()
    )

    try:
        provider = _build_oidc_provider(oidc)
        authorization = await provider.build_authorization_url()
    except OidcProviderError:
        return _oidc_error_redirect("provider_unavailable", secure=secure)

    if not _is_safe_authorization_redirect(authorization.url):
        return _oidc_error_redirect("provider_unavailable", secure=secure)

    try:
        start_transaction(
            db,
            issuer=oidc.issuer_url,
            operation=OPERATION_LOGIN,
            state=authorization.state,
            browser_secret=browser_secret,
            nonce=authorization.nonce,
            code_verifier=authorization.code_verifier,
        )
    except OidcTransactionError:
        return _oidc_error_redirect("provider_error", secure=secure)

    response = _oidc_redirect(authorization.url)
    _set_oidc_cookie(
        response, OIDC_BROWSER_COOKIE, browser_secret, secure=secure
    )
    return response


@router.get("/oidc/callback")
async def oidc_callback(request: Request, db: Session = Depends(get_db)):
    """Consume the browser-bound authorization, exchange the code, mint handoff."""
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    oidc = _require_oidc_config(policy)
    secure = _oidc_secure_cookies(oidc.redirect_uri)
    if not _consume_oidc_rate_limit(request, "callback"):
        return _oidc_error_redirect("provider_error", secure=secure)

    states = request.query_params.getlist("state")
    if len(states) != 1 or not states[0]:
        return _oidc_error_redirect("invalid_request", secure=secure)

    browser_secret = request.cookies.get(OIDC_BROWSER_COOKIE)
    if not browser_secret:
        return _oidc_error_redirect("invalid_state", secure=secure)

    _purge_expired_bounded(db)
    # Consume the browser-bound authorization *before* looking at provider
    # denial/error fields. A denial is a terminal result for this state: replaying
    # it or later presenting a code for the same state must fail closed.
    transaction = claim_authorization_transaction(
        db, state=states[0], browser_secret=browser_secret
    )
    if transaction is None:
        return _oidc_error_redirect("invalid_state", secure=secure)

    # Never reflect provider-controlled description text and never exchange a
    # code when the provider reported a denial.
    if request.query_params.get("error") is not None:
        return _oidc_error_redirect("provider_denied", secure=secure)

    codes = request.query_params.getlist("code")
    if len(codes) != 1 or not codes[0]:
        return _oidc_error_redirect("invalid_request", secure=secure)

    try:
        nonce = decrypted_nonce(transaction)
        code_verifier = decrypted_code_verifier(transaction)
    except OidcTransactionError:
        return _oidc_error_redirect("invalid_state", secure=secure)
    if not nonce or not code_verifier:
        return _oidc_error_redirect("invalid_state", secure=secure)

    try:
        provider = _build_oidc_provider(oidc)
        identity = await provider.exchange_code_for_identity(
            code=codes[0],
            code_verifier=code_verifier,
            nonce=nonce,
            require_fresh_auth=transaction.operation == OPERATION_LINK,
        )
    except OidcProviderError as exc:
        code = (
            "reauth_required"
            if exc.code == "reauth_required"
            else "provider_error"
        )
        return _oidc_error_redirect(code, secure=secure)

    if (
        identity.issuer != oidc.issuer_url
        or not identity.subject
    ):
        return _oidc_error_redirect("invalid_state", secure=secure)

    handoff_secret = generate_transaction_secret()
    try:
        promoted = promote_authorization_to_handoff(
            db,
            transaction_id=transaction.id,
            state=states[0],
            browser_secret=browser_secret,
            issuer=oidc.issuer_url,
            handoff_secret=handoff_secret,
            subject=identity.subject,
            auth_time=identity.auth_time,
            username_hint=validated_username_hint(
                identity.preferred_username, identity.name
            ),
        )
    except OidcTransactionError:
        return _oidc_error_redirect("restart", secure=secure)
    if promoted is None:
        # A newer start superseded this flow after the exchange; fail closed.
        return _oidc_error_redirect("restart", secure=secure)

    # Fixed completion path with no query/fragment: the handoff secret lives
    # only in the HttpOnly cookie and the database digest.
    response = _oidc_redirect(_OIDC_COMPLETE_PATH)
    _set_oidc_cookie(
        response,
        OIDC_HANDOFF_COOKIE,
        handoff_secret,
        secure=secure,
        max_age=60,
    )
    return response


def _bearer_user_for_completion(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = int(payload.get("sub"))
    except (JWTError, TypeError, ValueError):
        return None
    return (
        db.query(User)
        .filter(User.id == user_id, User.is_active == True)  # noqa: E712
        .first()
    )


@router.post("/oidc/complete")
async def oidc_complete(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Redeem the one-use handoff and issue an app token or link result.

    The stored operation is authoritative: the caller cannot choose login versus
    link. A login handoff issues the existing ``TokenResponse``, or previews a
    username prompt for a new identity with no usable provider hint. A link
    handoff returns ``{"linked": true}`` and never replaces the current session.
    """
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    oidc = _require_oidc_config(policy)
    secure = _oidc_secure_cookies(oidc.redirect_uri)

    # Enforced here regardless of global CORS middleware: CORS is not
    # authorization. Missing, literal-null and mismatched origins fail closed.
    origin = request.headers.get("origin")
    if origin is None or origin != oidc.app_origin:
        return _oidc_json(403, {"detail": "Invalid request origin"})

    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        return _oidc_json(415, {"detail": "JSON request body required"})

    if not _consume_oidc_rate_limit(request, "complete"):
        return _oidc_json(
            429, {"detail": "Too many sign-in attempts. Try again in a minute."}
        )
    try:
        data = await _read_oidc_json_object(request)
    except OidcRequestBodyTooLarge:
        return _oidc_json(413, {"detail": "Request body too large"})
    if data is None:
        return _oidc_json(400, {"detail": "Sign-in could not be completed"})
    _purge_expired_bounded(db)

    browser_secret = request.cookies.get(OIDC_BROWSER_COOKIE)
    handoff_secret = request.cookies.get(OIDC_HANDOFF_COOKIE)
    if not browser_secret or not handoff_secret:
        return _oidc_json(400, {"detail": "Sign-in could not be completed"})

    current_user = _bearer_user_for_completion(db, token)
    current_user_id = current_user.id if current_user is not None else None
    binding = {
        "handoff_secret": handoff_secret,
        "browser_secret": browser_secret,
        "expected_user_id": current_user_id,
        "bearer_token": token if current_user_id is not None else None,
    }
    preview = preview_handoff_transaction(db, **binding)
    if preview is None:
        return _oidc_json(400, {"detail": "Sign-in could not be completed"})
    if (
        preview.issuer == oidc.issuer_url
        and preview.operation == OPERATION_LOGIN
        and resolve_identity_user(db, preview.issuer, preview.subject) is None
        and validated_username_hint(preview.username_hint) is None
    ):
        if "username" not in data:
            return _oidc_json(200, {"username_required": True})
        username = data["username"]
        if not isinstance(username, str) or not 2 <= len(username.strip()) <= 32:
            return _oidc_json(400, {
                "code": "invalid_username",
                "detail": "Username must be between 2 and 32 characters",
            })
        return _complete_oidc_with_username(
            db, binding, username.strip(), expected_issuer=oidc.issuer_url
        )

    transaction = claim_handoff_transaction(
        db,
        handoff_secret=handoff_secret,
        browser_secret=browser_secret,
        expected_user_id=current_user_id,
        bearer_token=token if current_user_id is not None else None,
    )
    if transaction is None:
        return _oidc_json(400, {"detail": "Sign-in could not be completed"})

    # A handoff is still subject to the current trust policy. If the configured
    # issuer changed after callback validation (for example, during a provider
    # retirement/restart), consume but do not redeem the old issuer's identity.
    if transaction.issuer != oidc.issuer_url:
        return _oidc_json(400, {"detail": "Sign-in could not be completed"})

    if transaction.operation == OPERATION_LOGIN:
        user = resolve_identity_user(
            db, transaction.issuer, transaction.subject
        )
        if user is None:
            # An identity seen by preview may have been removed after claim.
            # This already-consumed legacy path cannot safely prompt now: fail
            # closed rather than silently creating an unnamed trainer account.
            if validated_username_hint(transaction.username_hint) is None:
                return _oidc_json(400, {"detail": "Sign-in could not be completed"})
            try:
                # The bounded provider hint was carried from callback to this
                # handoff. Provisioning sanitizes it again and uses a random
                # suffix if the usable provider-derived name is already taken.
                user = provision_user_for_identity(
                    db,
                    issuer=transaction.issuer,
                    subject=transaction.subject,
                    preferred_username=transaction.username_hint,
                )
            except OidcProvisioningError:
                return _oidc_json(500, {"detail": "Sign-in failed"})

        # Re-check after provisioning as well: a concurrent winner or a
        # pre-existing identity may resolve to an inactive account. An inactive
        # account must never receive an application JWT.
        if not user.is_active:
            return _oidc_json(403, {"detail": "Account is not available"})

        return _oidc_login_response(user)

    if transaction.operation == OPERATION_LINK:
        # Linking is only valid in mixed mode. A handoff started in mixed mode
        # must not survive a switch to oidc-only/local.
        if policy is None or policy.auth_mode != AUTH_MODE_MIXED:
            return _oidc_json(
                403, {"detail": "Account linking is not available"}
            )
        if current_user_id is None or token is None:
            return _oidc_json(401, {"detail": "Authentication required"})
        try:
            # The final local mutation runs under the same administrator
            # transition lock as unlink. It revalidates the exact claimed row,
            # re-reads/locks the active password-capable user and only then
            # inserts the identity; no provider network work happens here.
            finalize_link_handoff(
                db,
                transaction=transaction,
                current_user_id=current_user_id,
                bearer_token=token,
            )
        except OidcIdentityConflictError:
            return _oidc_json(409, {"detail": "Account could not be linked"})
        except OidcLinkCompletionError as exc:
            if exc.reason == LINK_REASON_POLICY:
                return _oidc_json(
                    403, {"detail": "Account linking is not available"}
                )
            if exc.reason == LINK_REASON_AUTHENTICATION:
                return _oidc_json(401, {"detail": "Authentication required"})
            return _oidc_json(
                400, {"detail": "Sign-in could not be completed"}
            )
        # Explicitly no token and no session/role change: the existing bearer
        # remains the operator's only application session.
        return _oidc_json(200, {"linked": True})

    return _oidc_json(400, {"detail": "Sign-in could not be completed"})


def _complete_oidc_with_username(
    db: Session, binding: dict, username: str, *, expected_issuer: str
):
    """Commit the conditional claim and exact-name provisioning as one unit."""
    try:
        transaction = claim_handoff_transaction(db, **binding, commit=False)
        if (
            transaction is None
            or transaction.operation != OPERATION_LOGIN
            or transaction.issuer != expected_issuer
        ):
            db.rollback()
            return _oidc_json(400, {"detail": "Sign-in could not be completed"})
        deadline = transaction.expires_at
        # Another completion may have provisioned this identity since preview.
        # Resolve it again under the claimed unit; its local name always wins.
        user = resolve_identity_user(db, transaction.issuer, transaction.subject)
        if user is None:
            user = provision_user_for_identity_with_username(
                db,
                issuer=transaction.issuer,
                subject=transaction.subject,
                username=username,
            )
        db.refresh(user)
        if not user.is_active:
            db.rollback()
            return _oidc_json(403, {"detail": "Account is not available"})
        # Unique-index contention can outlast the original 60-second deadline.
        # Never extend it, or commit candidate rows/consumption after it expires.
        if deadline <= datetime.utcnow():
            db.rollback()
            return _oidc_json(400, {"detail": "Sign-in could not be completed"})
        db.commit()
    except OidcUsernameTakenError:
        db.rollback()
        return _oidc_json(409, {
            "code": "username_taken", "detail": "Username already taken",
        })
    except Exception:
        db.rollback()
        return _oidc_json(500, {"detail": "Sign-in failed"})
    # No JWT is minted until the atomic unit is durably committed.
    return _oidc_login_response(user)


def _oidc_login_response(user: User) -> JSONResponse:
    return _oidc_json(
        200,
        TokenResponse(
            access_token=create_access_token({"sub": str(user.id), "role": user.role}),
            user={
                "id": user.id,
                "username": user.username,
                "role": user.role,
                "avatar_id": user.avatar_id,
                "must_change_password": user.must_change_password,
            },
        ).model_dump(),
    )


def _validate_oidc_post_request(request: Request, oidc) -> JSONResponse | None:
    """Enforce the browser Origin and JSON contract for identity mutations."""
    origin = request.headers.get("origin")
    if origin is None or origin != oidc.app_origin:
        return _oidc_json(403, {"detail": "Invalid request origin"})
    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        return _oidc_json(415, {"detail": "JSON request body required"})
    return None


# Identity mutation bodies are tiny (a password and a confirmation flag). The
# limit is enforced while streaming so a lying or absent Content-Length cannot
# make the server buffer an unbounded request body.
_OIDC_MAX_JSON_BODY_BYTES = 8 * 1024


class OidcRequestBodyTooLarge(Exception):
    """The streamed request body exceeded the fixed identity-mutation limit."""


async def _read_oidc_json_object(request: Request) -> dict | None:
    """Read a JSON object body, rejecting anything over 8 KiB while streaming."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _OIDC_MAX_JSON_BODY_BYTES:
            raise OidcRequestBodyTooLarge()
        chunks.append(chunk)
    body = b"".join(chunks)
    if not body:
        return None
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


@router.get("/oidc/identity")
def get_oidc_identity(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Return safe configured-provider status without exposing the subject.

    Local mode returns the same generic 404 as the other disabled OIDC routes,
    even for an unauthenticated caller: the policy is resolved before auth.
    """
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    oidc = _require_oidc_config(policy)
    current_user = _bearer_user_for_completion(db, token)
    if current_user is None:
        return _oidc_json(401, {"detail": "Not authenticated"})
    linked = find_user_identity(db, current_user.id, oidc.issuer_url) is not None
    unlink_permitted = bool(
        linked
        and policy.auth_mode == AUTH_MODE_MIXED
        and has_valid_password_hash(current_user.hashed_password)
    )
    return _oidc_json(
        200,
        {
            "linked": linked,
            "display_name": oidc.display_name,
            "unlink_permitted": unlink_permitted,
        },
    )


def _identity_is_only_remaining_admin_method(
    db: Session, user: User, policy: AuthPolicy
) -> bool:
    """Structural guard for removing this account's provider identity.

    True only when the account is an active administrator whose only method
    enabled by the current policy is the identity about to be removed, and it is
    the last usable administrator. Unlinking also requires a freshly verified
    local password, so in mixed mode this is defence in depth: the password
    remains usable afterwards.
    """
    if user is None or user.role != "admin" or not user.is_active:
        return False
    if policy.auth_mode != AUTH_MODE_OIDC_ONLY and has_valid_password_hash(
        user.hashed_password
    ):
        return False
    return count_usable_admins(db, policy) <= 1


@router.post("/oidc/link")
async def start_oidc_link(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Start explicit, password-reauthenticated linking for this user only."""
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    if policy.auth_mode != AUTH_MODE_MIXED:
        return _oidc_json(403, {"detail": "Account linking is not available"})
    oidc = _require_oidc_config(policy)
    invalid_request = _validate_oidc_post_request(request, oidc)
    if invalid_request is not None:
        return invalid_request
    if not _consume_oidc_rate_limit(request, "link"):
        return _oidc_json(
            429, {"detail": "Too many sign-in attempts. Try again in a minute."}
        )
    # Resolve the bearer account after the cheap request checks. Only a bearer
    # token identifies the target: no user id, subject or email from the body is
    # ever read, and the transaction stores this exact token's fingerprint.
    current_user = _bearer_user_for_completion(db, token)
    if current_user is None or token is None:
        return _oidc_json(401, {"detail": "Authentication required"})
    if not has_valid_password_hash(current_user.hashed_password):
        return _oidc_json(403, {"detail": "Account linking is not available"})
    try:
        data = await _read_oidc_json_object(request)
    except OidcRequestBodyTooLarge:
        return _oidc_json(413, {"detail": "Request body too large"})
    current_password = data.get("current_password") if data else None
    if not isinstance(current_password, str) or not current_password:
        return _oidc_json(400, {"detail": "Current password is required"})
    if not verify_password(current_password, current_user.hashed_password):
        return _oidc_json(401, {"detail": "Current password is incorrect"})
    if find_user_identity(db, current_user.id, oidc.issuer_url) is not None:
        return _oidc_json(409, {"detail": "Account could not be linked"})

    browser_secret = request.cookies.get(OIDC_BROWSER_COOKIE) or (
        generate_transaction_secret()
    )
    try:
        provider = _build_oidc_provider(oidc)
        authorization = await provider.build_authorization_url(
            prompt="login",
        )
        if not _is_safe_authorization_redirect(authorization.url):
            return _oidc_json(503, {"detail": "Sign-in provider is unavailable"})
        start_transaction(
            db,
            issuer=oidc.issuer_url,
            operation=OPERATION_LINK,
            state=authorization.state,
            browser_secret=browser_secret,
            nonce=authorization.nonce,
            code_verifier=authorization.code_verifier,
            user_id=current_user.id,
            bearer_token=token,
        )
    except OidcProviderError:
        return _oidc_json(503, {"detail": "Sign-in provider is unavailable"})
    except OidcTransactionError:
        return _oidc_json(503, {"detail": "Sign-in could not be started"})

    response = _oidc_json(200, {"authorization_url": authorization.url})
    _set_oidc_cookie(
        response,
        OIDC_BROWSER_COOKIE,
        browser_secret,
        secure=_oidc_secure_cookies(oidc.redirect_uri),
    )
    return response


@router.post("/oidc/unlink")
async def unlink_oidc_identity(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
):
    """Remove only the current user's provider identity after fresh proof."""
    policy, error = _oidc_policy_or_error()
    if error is not None:
        return error
    if policy.auth_mode != AUTH_MODE_MIXED:
        return _oidc_json(403, {"detail": "Account unlinking is not available"})
    oidc = _require_oidc_config(policy)
    invalid_request = _validate_oidc_post_request(request, oidc)
    if invalid_request is not None:
        return invalid_request
    if not _consume_oidc_rate_limit(request, "unlink"):
        return _oidc_json(
            429, {"detail": "Too many sign-in attempts. Try again in a minute."}
        )
    current_user = _bearer_user_for_completion(db, token)
    if current_user is None or token is None:
        return _oidc_json(401, {"detail": "Authentication required"})
    try:
        data = await _read_oidc_json_object(request)
    except OidcRequestBodyTooLarge:
        return _oidc_json(413, {"detail": "Request body too large"})
    current_password = data.get("current_password") if data else None
    if not isinstance(current_password, str) or not current_password:
        return _oidc_json(400, {"detail": "Current password is required"})
    if data.get("confirmation") is not True:
        return _oidc_json(400, {"detail": "Explicit confirmation is required"})

    # Serialize with other account-method transitions, then re-read the account
    # and identity under the shared lock before verifying the password again.
    user_id = current_user.id
    lock_admin_transitions(db)
    db.expire_all()
    # Row-lock the freshly loaded account for the whole mutation. The advisory
    # lock alone does not serialize /me/password or /me/force-password, so a
    # concurrent password update must wait for this row lock before committing.
    user = (
        db.query(User)
        .filter(User.id == user_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if user is None or not user.is_active:
        db.rollback()
        return _oidc_json(401, {"detail": "Authentication required"})
    if not has_valid_password_hash(user.hashed_password):
        db.rollback()
        return _oidc_json(403, {"detail": "Account unlinking is not available"})
    if not verify_password(current_password, user.hashed_password):
        db.rollback()
        return _oidc_json(401, {"detail": "Current password is incorrect"})

    identity = find_user_identity(db, user.id, oidc.issuer_url)
    if identity is None:
        db.rollback()
        return _oidc_json(409, {"detail": "Account is not linked"})

    subject = identity.subject
    try:
        db.delete(identity)
        db.flush()
        # Structural guard: removing this identity must leave at least one
        # usable administrator, and an administrator must keep a method.
        if _identity_is_only_remaining_admin_method(
            db, user, policy
        ) or (
            user.role == "admin"
            and user.is_active
            and not is_usable_admin(db, user, policy)
        ):
            db.rollback()
            return _oidc_json(
                409, {"detail": "A usable administrator must remain"}
            )
        # Invalidate in the same unit of work as the identity deletion: pending
        # link flows for this user and login handoffs for this exact identity.
        invalidate_user_transactions(db, user_id=user.id)
        invalidate_identity_transactions(
            db, issuer=oidc.issuer_url, subject=subject
        )
        db.commit()
    except OidcTransactionError:
        db.rollback()
        return _oidc_json(500, {"detail": "Account unlinking failed"})
    return _oidc_json(200, {"linked": False})


@router.post("/login", response_model=TokenResponse)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    if not auth_policy().password_login_enabled:
        raise HTTPException(status_code=403, detail="Password login is disabled; use single sign-on")
    user = db.query(User).filter(User.username == form_data.username, User.is_active == True).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_access_token({"sub": str(user.id), "role": user.role})
    return TokenResponse(
        access_token=token,
        user={
            "id": user.id,
            "username": user.username,
            "role": user.role,
            "avatar_id": user.avatar_id,
            "must_change_password": user.must_change_password,
        },
    )


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "role": current_user.role,
        "avatar_id": current_user.avatar_id,
        "must_change_password": current_user.must_change_password,
    }


@router.get("/mode")
def get_auth_mode(db: Session = Depends(get_db)):
    # `locked` tells the UI to disable the toggle: the mode is pinned by USER_MODE
    # or by AUTH_MODE (OIDC-enabled modes always require authentication).
    policy = auth_policy()
    return policy.capabilities(
        multi_user=_multi_user_enabled(db, policy),
        locked=mode_is_env_locked(),
    )


@router.put("/mode")
def set_auth_mode(
    enabled: bool = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    policy = auth_policy()
    if policy.mode_locked:
        raise HTTPException(
            status_code=409,
            detail=(
                f"User mode is fixed by AUTH_MODE={policy.auth_mode} and cannot be changed here"
            ),
        )
    if mode_is_env_locked():
        raise HTTPException(
            status_code=409,
            detail="User mode is pinned by the USER_MODE environment variable and cannot be changed here",
        )
    save_setting("multi_user_mode", str(enabled).lower())
    return {"multi_user": enabled}


@router.get("/users")
def list_users(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.id.asc()).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "is_active": u.is_active,
            "avatar_id": u.avatar_id,
            "created_at": str(u.created_at),
        }
        for u in users
    ]


@router.post("/users")
def create_user(
    data: CreateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if not auth_policy().password_management_enabled:
        raise HTTPException(
            status_code=403,
            detail="Password account creation is disabled for this deployment",
        )
    validate_avatar_id(data.avatar_id)
    existing = db.query(User).filter(User.username == data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(
        username=data.username,
        hashed_password=hash_password(data.password),
        role=data.role,
        is_active=True,
        avatar_id=data.avatar_id,
        must_change_password=data.must_change_password,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    data: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if data.password is not None and not auth_policy().password_management_enabled:
        raise HTTPException(
            status_code=403,
            detail="Password changes are disabled for this deployment",
        )
    if field_was_set(data, "avatar_id"):
        validate_avatar_id(data.avatar_id)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    policy = auth_policy()
    # Serialize administrator-method transitions, then discard session-cached
    # rows so the guard counts committed state from concurrent requests rather
    # than a racy pre-lock snapshot.
    lock_admin_transitions(db)
    db.expire_all()
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    next_role = data.role if data.role is not None else user.role
    next_is_active = data.is_active if data.is_active is not None else user.is_active
    try:
        ensure_admin_transition_keeps_usable_admin(
            db,
            user,
            policy,
            next_role=next_role,
            next_is_active=next_is_active,
        )
    except LastUsableAdminError:
        raise HTTPException(
            status_code=400,
            detail="At least one active admin account is required",
        ) from None
    if data.username is not None:
        _sync_public_handle_for_username(db, user, data.username)
        user.username = data.username
    if data.password is not None:
        user.hashed_password = hash_password(data.password)
    if data.role is not None:
        user.role = data.role
    if data.is_active is not None:
        user.is_active = data.is_active
    if field_was_set(data, "avatar_id"):
        user.avatar_id = data.avatar_id
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Trainer name or public URL is already taken") from None
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    policy = auth_policy()
    # Same shared transition lock as update_user: deleting an administrator must
    # not race another demotion/deactivation into zero usable administrators.
    lock_admin_transitions(db)
    db.expire_all()
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        ensure_admin_transition_keeps_usable_admin(
            db,
            user,
            policy,
            next_role="trainer",
            next_is_active=False,
        )
    except LastUsableAdminError:
        raise HTTPException(
            status_code=400,
            detail="At least one active admin account is required",
        ) from None
    # Delete all user-owned data first (foreign key constraints)
    from models import (
        Binder,
        BinderCard,
        Card,
        CollectionCardPhoto,
        CollectionItem,
        CustomCardMatch,
        ImageCache,
        OidcIdentity,
        PortfolioSnapshot,
        PriceHistory,
        ProductCard,
        ProductLedgerEntry,
        ProductPurchase,
        Trade,
        TradeItem,
        UserSetting,
        WishlistItem,
    )
    owned_custom_card_ids = [
        card_id for (card_id,) in db.query(Card.id).filter(
            Card.is_custom == True,
            Card.custom_owner_id == user_id,
        ).all()
    ]
    db.query(BinderCard).filter(
        BinderCard.binder_id.in_(db.query(Binder.id).filter(Binder.user_id == user_id))
    ).delete(synchronize_session=False)
    db.query(Binder).filter(Binder.user_id == user_id).delete()
    db.query(ProductLedgerEntry).filter(ProductLedgerEntry.user_id == user_id).delete()
    db.query(ProductCard).filter(ProductCard.user_id == user_id).delete()
    db.query(CollectionCardPhoto).filter(CollectionCardPhoto.user_id == user_id).delete()
    db.query(CollectionItem).filter(CollectionItem.user_id == user_id).delete()
    db.query(WishlistItem).filter(WishlistItem.user_id == user_id).delete()
    db.query(ProductPurchase).filter(ProductPurchase.user_id == user_id).delete()
    db.query(TradeItem).filter(TradeItem.user_id == user_id).delete(
        synchronize_session=False
    )
    db.query(Trade).filter(Trade.user_id == user_id).delete(
        synchronize_session=False
    )
    db.query(PortfolioSnapshot).filter(PortfolioSnapshot.user_id == user_id).delete()
    db.query(UserSetting).filter(UserSetting.user_id == user_id).delete()
    # Identity rows must never outlive the local account. Deleting explicitly
    # also covers SQLite, where foreign-key cascade enforcement is optional.
    # Invalidate outstanding OIDC transactions/handoffs in the same unit of work
    # first: login handoffs are not user-bound, so each exact identity pair must
    # be removed by issuer+subject as well as by user id.
    identities = (
        db.query(OidcIdentity)
        .filter(OidcIdentity.user_id == user_id)
        .all()
    )
    invalidate_user_transactions(db, user_id=user_id)
    for identity in identities:
        invalidate_identity_transactions(
            db, issuer=identity.issuer, subject=identity.subject
        )
    db.query(OidcIdentity).filter(OidcIdentity.user_id == user_id).delete(
        synchronize_session=False
    )
    if owned_custom_card_ids:
        db.query(CustomCardMatch).filter(
            CustomCardMatch.custom_card_id.in_(owned_custom_card_ids)
        ).delete(synchronize_session=False)
        db.query(PriceHistory).filter(
            PriceHistory.card_id.in_(owned_custom_card_ids)
        ).delete(synchronize_session=False)
        db.query(TradeItem).filter(
            TradeItem.card_id.in_(owned_custom_card_ids)
        ).update({"card_id": None}, synchronize_session=False)
        for card_id in owned_custom_card_ids:
            db.query(ImageCache).filter(
                ImageCache.image_key.like(f"card:{card_id}:%")
            ).delete(synchronize_session=False)
        db.query(Card).filter(Card.id.in_(owned_custom_card_ids)).delete(
            synchronize_session=False
        )
    traces_revoked = False
    try:
        from services.scan_trace import revoke_user_traces

        revoke_user_traces(user_id)
        traces_revoked = True
    except OSError as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="User scanner diagnostics could not be deleted.",
        ) from exc
    db.delete(user)
    try:
        db.commit()
    except Exception:
        db.rollback()
        if traces_revoked:
            try:
                from services.scan_trace import clear_user_trace_revocation

                clear_user_trace_revocation(user_id)
            except OSError:
                logger.exception(
                    "Failed to clear scanner diagnostics revocation after user deletion rollback"
                )
        raise
    return {"message": "User deleted"}


@router.put("/me/password")
def change_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not auth_policy().password_management_enabled:
        raise HTTPException(
            status_code=403,
            detail="Password changes are disabled for this deployment",
        )
    if not verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    db.commit()
    return {"message": "Password changed"}


@router.put("/me/force-password")
def force_change_password(
    data: ForceChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not auth_policy().password_management_enabled:
        raise HTTPException(
            status_code=403,
            detail="Password changes are disabled for this deployment",
        )
    if not current_user.must_change_password:
        raise HTTPException(status_code=400, detail="Password change is not required")
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    db.commit()
    return {"message": "Password changed"}


@router.put("/me/avatar")
def change_avatar(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    avatar_id = data.get("avatar_id")
    validate_avatar_id(avatar_id)
    current_user.avatar_id = avatar_id
    db.commit()
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}


@router.put("/me/username")
def change_username(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_username = (data.get("username") or "").strip()
    if not new_username or len(new_username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters")
    if len(new_username) > 32:
        raise HTTPException(status_code=400, detail="Username must be at most 32 characters")
    existing = db.query(User).filter(User.username == new_username, User.id != current_user.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")
    _sync_public_handle_for_username(db, current_user, new_username)
    current_user.username = new_username
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Trainer name or public URL is already taken") from None
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}
