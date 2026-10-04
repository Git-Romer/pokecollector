import unittest

try:
    from services.scheduler import scheduler
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "backend dependencies are not installed")
class SchedulerMisfireTests(unittest.TestCase):
    def test_late_wakeups_still_run_the_job(self):
        # A run that starts a few seconds late must still execute; with the
        # 1 s default the one-minute scan-queue job was skipped on hosts that
        # wake late.
        self.assertGreaterEqual(scheduler._job_defaults["misfire_grace_time"], 30)
        self.assertTrue(scheduler._job_defaults["coalesce"])


if __name__ == "__main__":
    unittest.main()
