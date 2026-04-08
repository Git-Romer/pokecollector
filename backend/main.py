from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Rate limiter: uses client IP, default 60 requests/minute
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting Pokemon TCG Collection API...")
    from database import SessionLocal, init_db
    from services.auth import bootstrap_admin
    init_db()
    logger.info("Database initialized")

    db = SessionLocal()
    try:
        bootstrap_admin(db)
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
    version="1.0.2",
    description="Complete Pokemon TCG collection management system",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "").split(",") if os.environ.get("CORS_ORIGINS") else ["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# Include routers
from api import auth, cards, collection, sets, wishlist, binders, dashboard, analytics, sync, products, export, backup, settings, images, social
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
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many login attempts. Try again in 1 minute."},
            )
        ip_attempts.append(now)
        attempts[client_ip] = ip_attempts
    return await call_next(request)
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(recognize_router, prefix="/api/cards", tags=["recognize"])
app.include_router(collection.router, prefix="/api/collection", tags=["collection"])
app.include_router(sets.router, prefix="/api/sets", tags=["sets"])
app.include_router(wishlist.router, prefix="/api/wishlist", tags=["wishlist"])
app.include_router(binders.router, prefix="/api/binders", tags=["binders"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(sync.router, prefix="/api/sync", tags=["sync"])
app.include_router(products.router, prefix="/api/products", tags=["products"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(backup.router, prefix="/api/backup", tags=["backup"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(images.router, prefix="/api/images", tags=["images"])
app.include_router(social.router, prefix="/api/social", tags=["social"])
app.include_router(github_router, prefix="/api/github", tags=["github"])


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "pokemon-tcg-collection"}
