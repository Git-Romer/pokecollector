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

        # Only run immediately if the DB has no cards (first boot)
        from database import SessionLocal
        from models import Card
        with SessionLocal() as db:
            needs_initial_sync = db.query(Card).count() == 0
        next_run = now_utc if needs_initial_sync else now_utc + datetime.timedelta(minutes=30)

        scheduler.add_job(
            run_sync,
            trigger=IntervalTrigger(minutes=30),
            id="sync_job",
            name="Pokemon TCG Sync",
            replace_existing=True,
            next_run_time=next_run,
        )
        scheduler.start()
        logger.info(
            f"Scheduler started at {now_utc.isoformat()} - sync every 30 minutes, "
            f"first run {'immediately' if needs_initial_sync else 'in 30 minutes'}"
        )
    else:
        logger.info("Scheduler already running")


def stop_scheduler():
    """Stop the background scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Scheduler stopped")
