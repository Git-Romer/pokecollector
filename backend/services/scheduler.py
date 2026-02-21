from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
import logging
import datetime

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()


def run_sync():
    """Main sync job - runs every 30 minutes."""
    from database import SessionLocal
    from services.sync_service import perform_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled sync...")
        perform_sync(db)
        logger.info("Scheduled sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled sync failed: {e}")
    finally:
        db.close()


def start_scheduler():
    """Start the background scheduler."""
    if not scheduler.running:
        # Use UTC-aware datetime for next_run_time
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        scheduler.add_job(
            run_sync,
            trigger=IntervalTrigger(minutes=30),
            id="sync_job",
            name="Pokemon TCG Sync",
            replace_existing=True,
            next_run_time=now_utc,  # Run immediately on first startup
        )
        scheduler.start()
        logger.info(f"Scheduler started at {now_utc.isoformat()} - sync every 30 minutes, first run immediately")
    else:
        logger.info("Scheduler already running")


def stop_scheduler():
    """Stop the background scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Scheduler stopped")
