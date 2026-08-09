import unittest

try:
    from services.gemini_rate_limit import TokenBucketLimiter
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


class FakeClock:
    """Virtual time so pacing assertions are exact and the tests stay instant."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def time(self):
        return self.now

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class TokenBucketLimiterTests(unittest.IsolatedAsyncioTestCase):
    async def test_burst_is_served_without_waiting(self):
        clock = FakeClock()
        limiter = TokenBucketLimiter(6, 3, time_fn=clock.time, sleep_fn=clock.sleep)

        for _ in range(3):
            await limiter.acquire()

        self.assertEqual(clock.sleeps, [])

    async def test_sustained_calls_are_paced_to_the_configured_rate(self):
        clock = FakeClock()
        # 6/min == one call per 10s once the burst is spent.
        limiter = TokenBucketLimiter(6, 3, time_fn=clock.time, sleep_fn=clock.sleep)
        for _ in range(3):
            await limiter.acquire()

        await limiter.acquire()

        self.assertEqual(len(clock.sleeps), 1)
        self.assertAlmostEqual(clock.sleeps[0], 10.0, places=5)

    async def test_tokens_refill_over_time(self):
        clock = FakeClock()
        limiter = TokenBucketLimiter(6, 3, time_fn=clock.time, sleep_fn=clock.sleep)
        for _ in range(3):
            await limiter.acquire()

        clock.now += 20.0  # 2 tokens' worth at 6/min
        await limiter.acquire()
        await limiter.acquire()

        self.assertEqual(clock.sleeps, [])

    async def test_penalty_blocks_callers_for_the_backoff_window(self):
        clock = FakeClock()
        limiter = TokenBucketLimiter(6, 3, time_fn=clock.time, sleep_fn=clock.sleep)

        limiter.penalize(30)
        start = clock.now
        await limiter.acquire()

        self.assertGreaterEqual(clock.now - start, 30.0)

    async def test_penalty_consumes_banked_burst(self):
        # A 429 means the bucket's estimate was wrong, so banked tokens must not
        # let the next few calls sail straight through.
        clock = FakeClock()
        limiter = TokenBucketLimiter(6, 3, time_fn=clock.time, sleep_fn=clock.sleep)

        limiter.penalize(30)
        await limiter.acquire()
        clock.sleeps.clear()
        await limiter.acquire()

        self.assertTrue(clock.sleeps, "second call after a penalty should still be paced")


if __name__ == "__main__":
    unittest.main()
