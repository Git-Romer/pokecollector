import unittest
from unittest.mock import Mock, patch

from services.pokemon_center_queue import QueueDetectionResult, classify_queue_response

try:
    import datetime

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import PokemonCenterQueueStatus, User, UserSetting
    from services.pokemon_center_queue import _queue_alert_users, check_pokemon_center_queue

    DB_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DB_TEST_DEPS_AVAILABLE = False


class PokemonCenterQueueDetectionTests(unittest.TestCase):
    def test_detects_queue_it_waiting_room_markers(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/waiting-room",
            status_code=200,
            headers={"Content-Type": "text/html"},
            body="<html><title>Waiting Room</title>You are now in line. Estimated wait time: 20 minutes.</html>",
        )

        self.assertEqual(result.status, "queue")
        self.assertIn("waiting-room", result.evidence["queue_url_markers"])
        self.assertIn("waiting room", result.evidence["queue_body_markers"])

    def test_detects_queue_it_token_markers(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://queue.pokemoncenter.com/",
            status_code=302,
            headers={"x-queueittoken": "abc"},
            body="",
        )

        self.assertEqual(result.status, "queue")
        self.assertIn("queue", result.evidence["queue_url_markers"])
        self.assertIn("x-queueittoken", result.evidence["queue_header_markers"])

    def test_detects_incapsula_as_bot_protection_not_queue(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/",
            status_code=200,
            headers={
                "X-Iinfo": "62-22952704-0 0NNN",
                "Set-Cookie": "visid_incap_2682446=abc; incap_ses_1783_2682446=def",
            },
            body="Request unsuccessful. Incapsula incident ID: 123",
        )

        self.assertEqual(result.status, "bot_protection")
        self.assertEqual(result.evidence["queue_body_markers"], [])
        self.assertIn("x-iinfo", result.evidence["bot_header_markers"])
        self.assertIn("incapsula", result.evidence["bot_body_markers"])

    def test_bot_protection_with_queue_like_url_does_not_alert_as_queue(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/queue",
            status_code=200,
            headers={"X-Iinfo": "62-22952704-0 0NNN"},
            body="Request unsuccessful. Incapsula incident ID: 123",
        )

        self.assertEqual(result.status, "bot_protection")
        self.assertIn("queue", result.evidence["queue_url_markers"])
        self.assertEqual(result.evidence["queue_body_markers"], [])
        self.assertIn("x-iinfo", result.evidence["bot_header_markers"])

    def test_classifies_plain_200_as_normal(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/",
            status_code=200,
            headers={"Content-Type": "text/html"},
            body="<html><title>Pokemon Center</title><main>Featured products</main></html>",
        )

        self.assertEqual(result.status, "normal")


class PokemonCenterQueueSchedulerTests(unittest.TestCase):
    def test_one_minute_interval_uses_thirty_second_jitter_window(self):
        try:
            from services.scheduler import _queue_check_trigger
        except ModuleNotFoundError as exc:
            self.skipTest(f"Scheduler dependencies are not installed: {exc}")

        trigger = _queue_check_trigger(1)

        self.assertEqual(trigger.interval.total_seconds(), 30)
        self.assertEqual(trigger.jitter, 60)

    def test_default_interval_uses_thirty_second_jitter_window(self):
        try:
            from services.scheduler import _queue_check_trigger
        except ModuleNotFoundError as exc:
            self.skipTest(f"Scheduler dependencies are not installed: {exc}")

        trigger = _queue_check_trigger(5)

        self.assertEqual(trigger.interval.total_seconds(), 270)
        self.assertEqual(trigger.jitter, 60)


@unittest.skipUnless(DB_TEST_DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class PokemonCenterQueueWorkflowTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.admin = User(username="admin", hashed_password="x", role="admin", is_active=True)
        self.trainer = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.inactive = User(username="misty", hashed_password="x", role="trainer", is_active=False)
        self.db.add_all([self.admin, self.trainer, self.inactive])
        self.db.commit()
        self.db.refresh(self.admin)
        self.db.refresh(self.trainer)
        self.db.refresh(self.inactive)

    def tearDown(self):
        self.db.close()

    def _setting(self, user, key, value):
        self.db.add(UserSetting(user_id=user.id, key=key, value=value))
        self.db.commit()

    def test_queue_subscribers_use_admin_env_telegram_fallback(self):
        self._setting(self.admin, "pokemon_center_queue_alerts_enabled", "true")

        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "token", "TELEGRAM_CHAT_ID": "123"}, clear=False):
            users = _queue_alert_users(self.db)

        self.assertEqual([user.id for user in users], [self.admin.id])

    def test_queue_subscribers_skip_inactive_and_unconfigured_users(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.inactive, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.inactive, "telegram_bot_token", "token")
        self._setting(self.inactive, "telegram_chat_id", "123")

        self.assertEqual(_queue_alert_users(self.db), [])

        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")

        self.assertEqual([user.id for user in _queue_alert_users(self.db)], [self.trainer.id])

    def test_bot_protection_does_not_notify(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        self.db.add(PokemonCenterQueueStatus(status="normal"))
        self.db.commit()

        result = QueueDetectionResult(
            status="bot_protection",
            evidence={"bot_body_markers": ["incapsula"]},
            http_status=200,
        )
        notify = Mock(return_value=1)
        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result), \
                patch("services.pokemon_center_queue._notify_queue_started", notify):
            response = check_pokemon_center_queue(self.db)

        self.assertEqual(response["status"], "bot_protection")
        notify.assert_not_called()

    def test_queue_notification_respects_cooldown(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        recent = datetime.datetime.utcnow()
        self.db.add(PokemonCenterQueueStatus(status="bot_protection", notified_at=recent))
        self.db.commit()

        result = QueueDetectionResult(
            status="queue",
            evidence={"queue_body_markers": ["waiting room"]},
            http_status=200,
        )
        notify = Mock(return_value=1)
        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result), \
                patch("services.pokemon_center_queue._notify_queue_started", notify):
            response = check_pokemon_center_queue(self.db)

        self.assertEqual(response["status"], "queue")
        self.assertEqual(response["notified_count"], 0)
        notify.assert_not_called()

    def test_skipped_check_persists_reason_for_admin_diagnostics(self):
        response = check_pokemon_center_queue(self.db)

        self.assertTrue(response["skipped"])
        self.assertEqual(response["reason"], "no opted-in Telegram users")
        row = self.db.query(PokemonCenterQueueStatus).one()
        self.assertEqual(row.evidence["reason"], "no opted-in Telegram users")
        self.assertEqual(row.error_message, "no opted-in Telegram users")


if __name__ == "__main__":
    unittest.main()
