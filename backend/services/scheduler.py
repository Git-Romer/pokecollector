from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.date import DateTrigger
import logging
import datetime

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()

_DEFAULT_FULL_SYNC_DAYS = 5
_DEFAULT_PRICE_SYNC_MINUTES = 30


def _get_full_sync_interval_days() -> int:
    """Read full sync interval from DB settings."""
    try:
        from database import SessionLocal
        from models import Setting
        with SessionLocal() as db:
            row = db.query(Setting).filter(Setting.key == "full_sync_interval_days").first()
            if row:
                return int(row.value)
    except Exception:
        pass
    return _DEFAULT_FULL_SYNC_DAYS


def _get_price_sync_interval_minutes() -> int:
    """Read price sync interval from DB settings."""
    try:
        from database import SessionLocal
        from models import Setting
        with SessionLocal() as db:
            row = db.query(Setting).filter(Setting.key == "price_sync_interval_minutes").first()
            if row:
                return int(row.value)
    except Exception:
        pass
    return _DEFAULT_PRICE_SYNC_MINUTES


def run_full_sync():
    """Full sync job — syncs sets + cards + prices."""
    from database import SessionLocal
    from services.sync_service import perform_full_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled full sync...")
        perform_full_sync(db)
        logger.info("Scheduled full sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled full sync failed: {e}")
    finally:
        db.close()


def run_price_sync():
    """Price-only sync job."""
    from database import SessionLocal
    from services.sync_service import perform_price_sync

    db = SessionLocal()
    try:
        logger.info("Starting scheduled price sync...")
        perform_price_sync(db)
        logger.info("Scheduled price sync completed successfully")
    except Exception as e:
        logger.error(f"Scheduled price sync failed: {e}")
    finally:
        db.close()


def run_pokedex_metadata_backfill():
    """One-time startup backfill for Pokédex mappings added to existing card rows."""
    from database import SessionLocal
    from services.pokedex_backfill import run_pokedex_metadata_backfill as run_backfill
    from services.pokedex_backfill import startup_pokedex_backfill_batch_delay_seconds
    from services.pokedex_backfill import startup_pokedex_backfill_batch_limit

    db = SessionLocal()
    try:
        logger.info("Starting one-time Pokédex metadata backfill...")
        result = run_backfill(
            db,
            batch_limit=startup_pokedex_backfill_batch_limit(),
            batch_delay_seconds=startup_pokedex_backfill_batch_delay_seconds(),
        )
        if result.get("skipped"):
            logger.info("Pokédex metadata backfill skipped: %s", result.get("reason"))
        elif result.get("completed"):
            logger.info(
                "Pokédex metadata backfill completed: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
        else:
            logger.warning(
                "Pokédex metadata backfill stopped before completion: attempted=%s updated=%s missing=%s failed=%s batches=%s",
                result["attempted"],
                result["updated"],
                result["missing"],
                result["failed"],
                result["batches"],
            )
    except Exception as e:
        logger.error("Pokédex metadata backfill failed: %s", e)
    finally:
        db.close()


# Keep legacy alias
def run_sync():
    """Legacy alias for run_full_sync."""
    run_full_sync()


def start_scheduler():
    """Start the background scheduler with separate full and small price sync jobs."""
    if not scheduler.running:
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        # Only run full sync immediately on first boot if DB has no cards
        from database import SessionLocal
        from models import Card
        from services.pokedex_backfill import (
            missing_pokedex_metadata_count,
            pokedex_metadata_backfill_completed,
            startup_pokedex_backfill_enabled,
        )
        with SessionLocal() as db:
            needs_initial_sync = db.query(Card).count() == 0
            needs_pokedex_backfill = (
                startup_pokedex_backfill_enabled()
                and not pokedex_metadata_backfill_completed(db)
                and missing_pokedex_metadata_count(db) > 0
            )

        full_interval_days = _get_full_sync_interval_days()
        price_interval_minutes = _get_price_sync_interval_minutes()

        # Job 1: Full sync (sets + cards + tracked prices)
        full_next_run = now_utc if needs_initial_sync else now_utc + datetime.timedelta(days=full_interval_days)
        scheduler.add_job(
            run_full_sync,
            trigger=IntervalTrigger(days=full_interval_days),
            id="full_sync_job",
            name="Pokemon TCG Full Sync",
            replace_existing=True,
            next_run_time=full_next_run,
        )

        # Recurring auto sync: small price sync.
        scheduler.add_job(
            run_price_sync,
            trigger=IntervalTrigger(minutes=price_interval_minutes),
            id="price_sync_job",
            name="Pokemon TCG Price Sync",
            replace_existing=True,
            next_run_time=now_utc + datetime.timedelta(minutes=price_interval_minutes),
        )

        if needs_pokedex_backfill:
            scheduler.add_job(
                run_pokedex_metadata_backfill,
                trigger=DateTrigger(run_date=now_utc + datetime.timedelta(seconds=30)),
                id="pokedex_metadata_backfill_job",
                name="One-time Pokédex Metadata Backfill",
                replace_existing=True,
            )

        scheduler.start()
        logger.info(
            f"Scheduler started — full sync every {full_interval_days} days "
            f"({'immediately' if needs_initial_sync else f'in {full_interval_days} days'}), "
            f"small price sync every {price_interval_minutes} minutes"
            f"{', one-time Pokédex metadata backfill scheduled' if needs_pokedex_backfill else ''}"
        )
    else:
        logger.info("Scheduler already running")


def stop_scheduler():
    """Stop the background scheduler."""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("Scheduler stopped")


def reschedule_full_sync(interval_days: int):
    """Reschedule the full sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "full_sync_job",
            trigger=IntervalTrigger(days=interval_days),
        )
        logger.info(f"Full sync rescheduled to every {interval_days} days")


def reschedule_price_sync(interval_minutes: int):
    """Reschedule the price sync job with a new interval."""
    if scheduler.running:
        scheduler.reschedule_job(
            "price_sync_job",
            trigger=IntervalTrigger(minutes=interval_minutes),
        )
        logger.info(f"Price sync rescheduled to every {interval_minutes} minutes")
