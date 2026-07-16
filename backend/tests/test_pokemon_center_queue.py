import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from services.pokemon_center_queue import (
    QueueDetectionResult,
    classify_incapsula_resource_response,
    classify_queue_response,
    fetch_queue_status,
)

try:
    import datetime

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import PokemonCenterQueueStatus, Setting, User, UserSetting
    from services.pokemon_center_queue import (
        _queue_alert_users,
        check_pokemon_center_queue,
        get_or_create_browser_report_token,
        record_queue_observation,
        record_queue_observation_with_token,
    )

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

    def test_detects_incapsula_queue_position_json(self):
        result = classify_incapsula_resource_response(
            url="https://www.pokemoncenter.com/_Incapsula_Resource",
            status_code=200,
            headers={"Content-Type": "application/json"},
            body='{"pos": 4812}',
        )

        self.assertEqual(result.status, "queue")
        self.assertEqual(result.evidence["queue_position"], 4812)
        self.assertIn("pos", result.evidence["json_keys"])

    def test_rejects_non_integer_incapsula_queue_positions(self):
        for body in ('{"pos": true}', '{"pos": 1.9}', '{"pos": 0}', '{"pos": -3}'):
            with self.subTest(body=body):
                result = classify_incapsula_resource_response(
                    url="https://www.pokemoncenter.com/_Incapsula_Resource",
                    status_code=200,
                    headers={"Content-Type": "application/json"},
                    body=body,
                )

                self.assertEqual(result.status, "unknown")
                self.assertNotIn("queue_position", result.evidence)

    def test_ignores_incapsula_captcha_html_without_queue_position(self):
        result = classify_incapsula_resource_response(
            url="https://www.pokemoncenter.com/_Incapsula_Resource",
            status_code=200,
            headers={"Content-Type": "text/html"},
            body="<html><title>[Error Title]</title><div class='h-captcha'></div></html>",
        )

        self.assertEqual(result.status, "unknown")
        self.assertNotIn("queue_position", result.evidence)

    def test_fetch_promotes_incapsula_resource_position_to_queue(self):
        main_body = (
            "<html><body><iframe src=\"/_Incapsula_Resource?incident_id=abc\"></iframe>"
            "Request unsuccessful. Incapsula incident ID: abc</body></html>"
        )
        responses = [
            SimpleNamespace(
                url="https://www.pokemoncenter.com/",
                status_code=200,
                headers={"X-Iinfo": "62-22952704-0 0NNN"},
                text=main_body,
            ),
            SimpleNamespace(
                url="https://www.pokemoncenter.com/_Incapsula_Resource?incident_id=abc",
                status_code=200,
                headers={"Content-Type": "application/json"},
                text='{"pos": "42"}',
            ),
        ]
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=None)
        client.get = Mock(side_effect=responses)
        fake_httpx = SimpleNamespace(Client=Mock(return_value=client))

        with patch.dict("sys.modules", {"httpx": fake_httpx}):
            result = fetch_queue_status()

        self.assertEqual(result.status, "queue")
        self.assertEqual(result.evidence["incapsula_resource_probe"]["queue_position"], 42)
        self.assertEqual(client.get.call_count, 2)


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

    def test_manual_queue_observation_notifies_subscribers(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        self.db.add(PokemonCenterQueueStatus(status="bot_protection"))
        self.db.commit()

        notify = Mock(return_value=1)
        with patch("services.pokemon_center_queue._notify_queue_started", notify):
            response = record_queue_observation(self.db, source="admin_manual")

        self.assertEqual(response["status"], "queue")
        self.assertEqual(response["previous_status"], "bot_protection")
        self.assertEqual(response["notified_count"], 1)
        notify.assert_called_once()
        row = self.db.query(PokemonCenterQueueStatus).one()
        self.assertEqual(row.status, "queue")
        self.assertEqual(row.evidence["source"], "admin_manual")

    def test_failed_manual_queue_notification_does_not_start_cooldown(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        self.db.add(PokemonCenterQueueStatus(status="bot_protection"))
        self.db.commit()

        with patch("services.pokemon_center_queue._notify_queue_started", Mock(return_value=0)):
            response = record_queue_observation(self.db, source="admin_manual")

        self.assertEqual(response["notified_count"], 0)
        self.assertIsNone(response["notified_at"])
        row = self.db.query(PokemonCenterQueueStatus).one()
        self.assertIsNone(row.notified_at)

    def test_browser_report_token_required(self):
        self.db.add(Setting(key="pokemon_center_queue_browser_report_token", value="expected-token"))
        self.db.commit()

        self.assertIsNone(
            record_queue_observation_with_token(
                self.db,
                token="wrong-token",
                source="browser_report",
            )
        )

        result = record_queue_observation_with_token(
            self.db,
            token="expected-token",
            source="browser_report",
            position=123,
        )

        self.assertEqual(result["status"], "queue")
        self.assertEqual(result["evidence"]["queue_position"], 123)

    def test_invalid_browser_report_does_not_create_token_or_raise(self):
        result = record_queue_observation_with_token(
            self.db,
            token="falscher-token-ä",
            source="browser_report",
        )

        self.assertIsNone(result)
        row = self.db.query(Setting).filter(Setting.key == "pokemon_center_queue_browser_report_token").first()
        self.assertIsNone(row)

    def test_browser_report_token_is_created_once(self):
        first = get_or_create_browser_report_token(self.db)
        second = get_or_create_browser_report_token(self.db)

        self.assertTrue(first)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
