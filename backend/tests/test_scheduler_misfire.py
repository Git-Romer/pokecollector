import datetime
import threading
import time
import unittest
from unittest.mock import patch

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    import services.scheduler as scheduler_module

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


class _FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def query(self, _model):
        return self

    def count(self):
        return 1


class _LateScanQueueScheduler:
    def __init__(self):
        self.inner = BackgroundScheduler()

    @property
    def running(self):
        return self.inner.running

    def add_job(self, func, trigger=None, **options):
        if options.get("id") == "scan_queue_maintenance_job":
            options["next_run_time"] = datetime.datetime.now(
                datetime.timezone.utc
            ) - datetime.timedelta(seconds=4)
        return self.inner.add_job(func, trigger=trigger, **options)

    def start(self):
        self.inner.start()

    def shutdown(self):
        self.inner.shutdown(wait=True)


@unittest.skipUnless(DEPS, "backend scheduler dependencies are not installed")
class SchedulerMisfireTests(unittest.TestCase):
    def test_only_scan_queue_gets_grace_and_runs_after_a_late_wakeup(self):
        scheduler = _LateScanQueueScheduler()
        calls = []
        completed = threading.Event()

        def record_scan_queue_run():
            calls.append(time.monotonic())
            completed.set()

        try:
            with (
                patch.object(scheduler_module, "scheduler", scheduler),
                patch.object(
                    scheduler_module,
                    "run_scan_queue_maintenance",
                    record_scan_queue_run,
                ),
                patch("database.SessionLocal", return_value=_FakeSession()),
                patch.object(
                    scheduler_module, "_get_full_sync_interval_days", return_value=5
                ),
                patch.object(
                    scheduler_module,
                    "_get_price_sync_interval_minutes",
                    return_value=30,
                ),
                patch(
                    "services.pokedex_backfill.startup_pokedex_backfill_enabled",
                    return_value=True,
                ),
                patch(
                    "services.pokedex_backfill.pokedex_metadata_backfill_completed",
                    return_value=False,
                ),
                patch(
                    "services.pokedex_backfill.missing_pokedex_metadata_count",
                    return_value=1,
                ),
            ):
                scheduler_module.start_scheduler()
                scan_job = scheduler.inner.get_job("scan_queue_maintenance_job")
                self.assertEqual(scan_job.misfire_grace_time, 60)
                self.assertTrue(scan_job.coalesce)
                self.assertEqual(
                    scheduler.inner.get_job("full_sync_job").misfire_grace_time, 1
                )
                self.assertEqual(
                    scheduler.inner.get_job("price_sync_job").misfire_grace_time, 1
                )
                self.assertEqual(
                    scheduler.inner.get_job("pokedex_metadata_backfill_job").misfire_grace_time,
                    1,
                )
                self.assertTrue(
                    completed.wait(timeout=5),
                    "the delayed scan-queue job was not dispatched",
                )
                time.sleep(0.1)
                self.assertEqual(len(calls), 1)
        finally:
            if scheduler.running:
                scheduler.shutdown()


if __name__ == "__main__":
    unittest.main()
