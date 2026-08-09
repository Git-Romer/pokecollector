import unittest
from unittest.mock import AsyncMock, MagicMock, patch

try:
    from services.scheduler import run_scan_queue_maintenance

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Scheduler dependencies are not installed")
class ScanQueueSchedulerTests(unittest.TestCase):
    def test_maintenance_runs_quota_cleanup_and_queue_drain(self):
        db = MagicMock()
        drain = AsyncMock(return_value=0)

        with patch("database.SessionLocal", return_value=db), \
                patch("services.scan_queue.recover_expired_leases", return_value=0), \
                patch("services.scan_queue.purge_expired_scan_jobs", return_value=0), \
                patch("services.scan_storage.purge_orphaned_scan_directories", return_value=0), \
                patch("services.gemini_rate_limit.purge_stale_quota_states", return_value=0) as purge_quotas, \
                patch("services.scan_queue.drain_scan_queue", new=drain):
            run_scan_queue_maintenance()

        purge_quotas.assert_called_once_with()
        drain.assert_awaited_once_with(max_items=50)
        db.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
