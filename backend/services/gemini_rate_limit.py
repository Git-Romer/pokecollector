"""Process-wide pacing for Gemini calls.

Gemini's free tier allows roughly 6 requests/minute; exceeding it returns 429.
Every Gemini call in the app goes through one shared token bucket so a queued
batch and an interactive scan cannot collectively bust the quota.

Token bucket rather than a fixed sleep between calls: an idle system still
serves an interactive scan immediately (there are tokens banked), while a long
batch settles to the sustained refill rate.
"""

from __future__ import annotations

import asyncio
import os
import time

DEFAULT_RATE_PER_MIN = 6.0
DEFAULT_BURST = 3.0
# How long to stop issuing calls after Gemini itself says 429. The bucket
# thought it had budget and was wrong, so back off rather than retry straight in.
DEFAULT_PENALTY_SECONDS = 30.0


def _env_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


class TokenBucketLimiter:
    def __init__(self, rate_per_min: float, burst: float, *, time_fn=time.monotonic, sleep_fn=asyncio.sleep):
        self.rate_per_sec = rate_per_min / 60.0
        self.capacity = burst
        self._tokens = burst
        self._time = time_fn
        self._sleep = sleep_fn
        self._updated = time_fn()
        self._blocked_until = 0.0
        self._lock = asyncio.Lock()

    def _refill(self) -> None:
        now = self._time()
        elapsed = now - self._updated
        if elapsed > 0:
            self._tokens = min(self.capacity, self._tokens + elapsed * self.rate_per_sec)
            self._updated = now

    async def acquire(self) -> None:
        """Block until one call's worth of budget is available, then consume it."""
        async with self._lock:
            while True:
                now = self._time()
                if now < self._blocked_until:
                    await self._sleep(self._blocked_until - now)
                    continue
                self._refill()
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                deficit = 1 - self._tokens
                await self._sleep(deficit / self.rate_per_sec)

    def penalize(self, seconds: float = DEFAULT_PENALTY_SECONDS) -> None:
        """Called after an upstream 429 — hold off all callers for a while.

        The refill baseline moves to the end of the block rather than now, so
        the wait does not silently bank a burst: resuming with a full bucket
        would fire several calls back to back and re-trigger the 429 the
        penalty exists to avoid. One token is granted so the first call goes
        out as soon as the window closes, and the rest are paced normally.
        """
        self._blocked_until = max(self._blocked_until, self._time() + seconds)
        self._tokens = 1.0
        self._updated = self._blocked_until


_limiter: TokenBucketLimiter | None = None


def get_limiter() -> TokenBucketLimiter:
    global _limiter
    if _limiter is None:
        _limiter = TokenBucketLimiter(
            _env_float("GEMINI_RATE_PER_MIN", DEFAULT_RATE_PER_MIN),
            _env_float("GEMINI_RATE_BURST", DEFAULT_BURST),
        )
    return _limiter


def reset_limiter() -> None:
    """Test hook — drop the process-wide bucket so a test can install its own."""
    global _limiter
    _limiter = None
