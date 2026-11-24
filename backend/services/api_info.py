"""Capability markers advertised by ``GET /api/health``.

Clients (the offline outbox) read these to decide whether queued writes can be
sent safely: a backend without ``idempotency-v1`` must never receive a replay.
"""

API_LEVEL = 1
API_FEATURES = ("idempotency-v1",)
