from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting Pokemon TCG Collection API...")
    from database import init_db
    init_db()
    logger.info("Database initialized")

    from services.scheduler import start_scheduler
    start_scheduler()

    yield

    # Shutdown
    from services.scheduler import stop_scheduler
    stop_scheduler()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Pokemon TCG Collection API",
    version="1.0.0",
    description="Complete Pokemon TCG collection management system",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
from api import cards, collection, sets, wishlist, binders, dashboard, analytics, sync, products, export, backup, settings
from api.recognize import router as recognize_router
from api.ebay import router as ebay_router

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
app.include_router(ebay_router, prefix="/api/ebay", tags=["ebay"])


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "pokemon-tcg-collection"}
