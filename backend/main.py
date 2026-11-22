from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import logging
import os
import time
from pathlib import Path

from services.api_info import API_FEATURES, API_LEVEL

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Normal access logging stays enabled; only the OIDC query string (one-time
# callback code/state) is stripped at the logging boundary.
from services.access_log import install_oidc_access_log_redaction  # noqa: E402

install_oidc_access_log_redaction()

# Rate limiter: uses client IP, default 60 requests/minute
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])


def read_app_version() -> str:
    """Read the release version from the repository VERSION file."""
    env_version = os.environ.get("APP_VERSION")
    if env_version:
        return env_version

    for candidate in (
        Path(__file__).resolve().parent.parent / "VERSION",
        Path(__file__).resolve().parent / "VERSION",
        Path("/app/VERSION"),
    ):
        try:
            version = candidate.read_text(encoding="utf-8").strip()
            if version:
                return version
        except OSError:
            continue
    return "0.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting Pokemon TCG Collection API...")
    from api.auth import env_user_mode
    from services.auth_policy import AuthConfigError, validate_startup_auth_config

    _forced_mode = env_user_mode(warn_invalid=True)
    # Syntax-only validation: fail closed before any database mutation or upgrade
    # backup. No provider network access happens here.
    try:
        _auth_policy = validate_startup_auth_config(user_mode=_forced_mode)
    except AuthConfigError as exc:
        # Messages name configuration variables only, never secret values.
        raise RuntimeError(f"Invalid authentication configuration: {exc}") from exc
    if _auth_policy.authentication_required:
        logger.info(
            "AUTH_MODE=%s: authentication is mandatory; password login %s, OIDC %s.",
            _auth_policy.auth_mode,
            "enabled" if _auth_policy.password_login_enabled else "disabled",
            "enabled" if _auth_policy.oidc_enabled else "disabled",
        )
    if _forced_mode == "single":
        logger.warning(
            "USER_MODE=single: single-user mode is forced and the login screen is disabled "
            "regardless of the stored setting. This is a local recovery hatch - unset it once "
            "you have regained access, and do not leave it set on a public install."
        )
    elif _forced_mode == "multi":
        logger.info("USER_MODE=multi: multi-user mode is forced; the in-app toggle is disabled.")
    current_version = read_app_version()
    from database import DATABASE_URL, SessionLocal, engine, init_db
    from services.auth_admin import initialize_admin_accounts
    from services.pre_upgrade_backup import maybe_create_pre_upgrade_backup, record_successful_app_version
    maybe_create_pre_upgrade_backup(engine, DATABASE_URL, current_version)
    # OIDC schema migrations only run when OIDC is configured: a local-mode
    # deployment must start unchanged against a pre-OIDC database, including an
    # existing SQLite file whose users.hashed_password is still NOT NULL.
    init_db(enable_oidc_schema=_auth_policy.oidc is not None)
    logger.info("Database initialized")

    db = SessionLocal()
    try:
        # Local/mixed keep the legacy password bootstrap. OIDC-only never mints a
        # password administrator: it validates that an active administrator is
        # already linked to the configured issuer (start mixed first, link, then
        # switch) and aborts startup with an actionable error otherwise.
        initialize_admin_accounts(db, _auth_policy)
        from services.public_profile import migrate_public_profile_handles
        public_handle_migration = migrate_public_profile_handles(db)
        if public_handle_migration["migrated"] or public_handle_migration["disabled"]:
            logger.info(
                "Public trainer-name URL migration updated %s profiles and disabled %s invalid/conflicting profiles",
                public_handle_migration["migrated"],
                public_handle_migration["disabled"],
            )
        from models import Setting
        from services.debug_logging import configure_debug_logging
        debug_setting = db.query(Setting).filter(Setting.key == "debug_mode").first()
        configure_debug_logging(debug_setting is not None and debug_setting.value == "true")
        record_successful_app_version(engine, current_version)
    finally:
        db.close()

    from services.scheduler import start_scheduler
    start_scheduler()

    yield

    # Shutdown
    from services.scheduler import stop_scheduler
    stop_scheduler()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Pokemon TCG Collection API",
    version=read_app_version(),
    description="Complete Pokemon TCG collection management system",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@app.middleware("http")
async def prevent_failed_public_response_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/public") and response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "").split(",") if os.environ.get("CORS_ORIGINS") else ["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Expected-User-Id"],
)


_OIDC_CORS_RESPONSE_HEADERS = (
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
)


def _finish_oidc_response(response):
    """Force no-store/no-referrer and remove any wildcard CORS echo."""
    for header in _OIDC_CORS_RESPONSE_HEADERS:
        if header in response.headers:
            del response.headers[header]
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.middleware("http")
async def oidc_cors_and_error_boundary(request: Request, call_next):
    """Scope exact-origin CORS to OIDC and keep security headers outermost.

    This middleware is added after ``CORSMiddleware``, so it is outer to it:
    unauthorized OIDC preflights are rejected before the global wildcard policy
    can echo a credential-bearing origin, and any CORS headers the global
    middleware added to an OIDC response are stripped. It also converts an
    unhandled OIDC exception into a generic 500 *inside* the user middleware
    stack so no-store/no-referrer still apply. Legacy endpoints are untouched.
    It never reads or logs query strings, codes, states or cookie values.
    """
    from services.auth_policy import AuthConfigError, load_auth_policy

    path = request.url.path
    if not path.startswith("/api/auth/oidc"):
        return await call_next(request)

    if request.method == "OPTIONS":
        try:
            policy = load_auth_policy()
        except AuthConfigError:
            return _finish_oidc_response(
                JSONResponse(
                    status_code=503,
                    content={"detail": "Authentication is misconfigured"},
                )
            )
        if policy.oidc is None:
            return _finish_oidc_response(
                JSONResponse(status_code=404, content={"detail": "Not found"})
            )
        origin = request.headers.get("origin")
        if origin is None or origin != policy.oidc.app_origin:
            return _finish_oidc_response(
                JSONResponse(
                    status_code=403,
                    content={"detail": "Invalid request origin"},
                )
            )
        response = _finish_oidc_response(Response(status_code=204))
        # Exact configured origin only; never `*` and never a reflected
        # arbitrary origin with credentials.
        response.headers["Access-Control-Allow-Origin"] = policy.oidc.app_origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Authorization, Content-Type"
        )
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Max-Age"] = "600"
        response.headers["Vary"] = "Origin"
        return response

    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001 - OIDC boundary must fail generic
        # Class name only: never let an exception message containing a callback
        # URL/query/token reach the logs.
        logger.warning(
            "Unhandled OIDC request failure (%s)", type(exc).__name__
        )
        return _finish_oidc_response(
            JSONResponse(
                status_code=500,
                content={"detail": "Internal server error"},
            )
        )
    return _finish_oidc_response(response)



@app.middleware("http")
async def debug_request_logging(request: Request, call_next):
    from services.debug_logging import is_debug_logging_enabled

    if not is_debug_logging_enabled():
        return await call_next(request)

    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Request failed: %s %s", request.method, request.url.path)
        raise

    duration_ms = (time.perf_counter() - started) * 1000
    logger.debug(
        "Request: %s %s -> %s %.1fms",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response

# Include routers
from api import auth, cards, collection, sets, wishlist, binders, decks, dashboard, analytics, sync, products, trades, export, backup, settings, images, social, pokedex, public, profile, scan_jobs, community, push
from api.github import router as github_router
from api.recognize import router as recognize_router

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

# Strict rate limit on login: 5 attempts per minute per IP
@app.middleware("http")
async def login_rate_limit(request: Request, call_next):
    if request.url.path == "/api/auth/login" and request.method == "POST":
        client_ip = get_remote_address(request)
        # Use in-memory counter
        import time
        now = time.time()
        if not hasattr(app.state, "_login_attempts"):
            app.state._login_attempts = {}
        attempts = app.state._login_attempts
        # Clean old entries
        attempts = {k: v for k, v in attempts.items() if now - v[-1] < 60}
        app.state._login_attempts = attempts
        # Check this IP
        ip_attempts = attempts.get(client_ip, [])
        ip_attempts = [t for t in ip_attempts if now - t < 60]
        if len(ip_attempts) >= 5:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many login attempts. Try again in 1 minute."},
            )
        ip_attempts.append(now)
        attempts[client_ip] = ip_attempts
    return await call_next(request)
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(recognize_router, prefix="/api/cards", tags=["recognize"])
app.include_router(scan_jobs.router, prefix="/api/cards", tags=["scan-jobs"])
app.include_router(collection.router, prefix="/api/collection", tags=["collection"])
app.include_router(sets.router, prefix="/api/sets", tags=["sets"])
app.include_router(wishlist.router, prefix="/api/wishlist", tags=["wishlist"])
app.include_router(binders.router, prefix="/api/binders", tags=["binders"])
app.include_router(decks.router, prefix="/api/decks", tags=["decks"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(sync.router, prefix="/api/sync", tags=["sync"])
app.include_router(products.router, prefix="/api/products", tags=["products"])
app.include_router(trades.router, prefix="/api/trades", tags=["trades"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(backup.router, prefix="/api/backup", tags=["backup"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(images.router, prefix="/api/images", tags=["images"])
app.include_router(social.router, prefix="/api/social", tags=["social"])
app.include_router(pokedex.router, prefix="/api/pokedex", tags=["pokedex"])
app.include_router(public.router, prefix="/api/public", tags=["public"])
app.include_router(profile.router, prefix="/api/profile", tags=["profile"])
app.include_router(github_router, prefix="/api/github", tags=["github"])
app.include_router(community.router, prefix="/api/community", tags=["community"])
app.include_router(push.router, prefix="/api/push", tags=["push"])


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "pokemon-tcg-collection",
        "version": read_app_version(),
        "api_level": API_LEVEL,
        "features": list(API_FEATURES),
    }
