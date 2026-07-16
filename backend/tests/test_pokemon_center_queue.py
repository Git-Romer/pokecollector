import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import services.pokemon_center_queue as queue_service
from services.pokemon_center_queue import (
    QueueDetectionResult,
    classify_browser_snapshot,
    classify_incapsula_resource_response,
    classify_queue_response,
    fetch_browser_queue_status,
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

    def test_detects_confident_queue_host_marker(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://queue.pokemoncenter.com/",
            status_code=200,
            headers={"Content-Type": "text/html"},
            body="",
        )

        self.assertEqual(result.status, "queue")
        self.assertTrue(result.evidence["queue_url_confident"])

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

    def test_bot_protection_with_queue_text_does_not_alert_as_queue(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/",
            status_code=200,
            headers={"X-Iinfo": "62-22952704-0 0NNN"},
            body="Request unsuccessful. Incapsula incident ID: 123. Waiting room assets are unavailable.",
        )

        self.assertEqual(result.status, "bot_protection")
        self.assertIn("waiting room", result.evidence["queue_body_markers"])
        self.assertIn("x-iinfo", result.evidence["bot_header_markers"])

    def test_generic_queue_url_marker_without_queue_content_does_not_alert(self):
        result = classify_queue_response(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/search?query=queue",
            status_code=200,
            headers={"Content-Type": "text/html"},
            body="<html><title>Pokemon Center</title><main>Featured products</main></html>",
        )

        self.assertEqual(result.status, "normal")
        self.assertIn("queue", result.evidence["queue_url_markers"])
        self.assertFalse(result.evidence["queue_url_confident"])

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

    def test_browser_snapshot_detects_rendered_queue_markers(self):
        result = classify_browser_snapshot(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/",
            status_code=200,
            body="Welcome to the virtual waiting room. You are now in line.",
        )

        self.assertEqual(result.status, "queue")
        self.assertTrue(result.evidence["browser_rendered"])
        self.assertIn("virtual waiting room", result.evidence["queue_body_markers"])

    def test_browser_snapshot_detects_incapsula_queue_position_network_signal(self):
        result = classify_browser_snapshot(
            url="https://www.pokemoncenter.com/",
            final_url="https://www.pokemoncenter.com/",
            status_code=200,
            body="Request unsuccessful. Incapsula incident ID: 123",
            network_evidence=[
                {
                    "url": "https://www.pokemoncenter.com/_Incapsula_Resource",
                    "http_status": 200,
                    "queue_position": 321,
                }
            ],
        )

        self.assertEqual(result.status, "queue")
        self.assertEqual(result.evidence["queue_position"], 321)
        self.assertTrue(result.evidence["browser_rendered"])

    def test_fetch_uses_browser_fallback_when_http_stays_bot_protected_if_requested(self):
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
                headers={"Content-Type": "text/html"},
                text="<html><div class='h-captcha'></div></html>",
            ),
        ]
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=None)
        client.get = Mock(side_effect=responses)
        fake_httpx = SimpleNamespace(Client=Mock(return_value=client))
        browser_result = QueueDetectionResult(
            status="queue",
            evidence={"browser_rendered": True, "queue_body_markers": ["waiting room"]},
            http_status=200,
        )

        with patch.dict("sys.modules", {"httpx": fake_httpx}), \
                patch("services.pokemon_center_queue.fetch_browser_queue_status", return_value=browser_result):
            result = fetch_queue_status(browser_probe=True)

        self.assertEqual(result.status, "queue")
        self.assertTrue(result.evidence["browser_probe"]["browser_rendered"])

    def test_fetch_skips_browser_fallback_when_http_looks_normal_by_default(self):
        responses = [
            SimpleNamespace(
                url="https://www.pokemoncenter.com/",
                status_code=200,
                headers={"Content-Type": "text/html"},
                text="<html><title>Pokemon Center</title><main>Featured products</main></html>",
            ),
        ]
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=None)
        client.get = Mock(side_effect=responses)
        fake_httpx = SimpleNamespace(Client=Mock(return_value=client))
        browser_fetch = Mock()

        with patch.dict("sys.modules", {"httpx": fake_httpx}), \
                patch("services.pokemon_center_queue.fetch_browser_queue_status", browser_fetch):
            result = fetch_queue_status()

        self.assertEqual(result.status, "normal")
        browser_fetch.assert_not_called()

    def test_fetch_uses_browser_fallback_when_http_looks_normal_if_requested(self):
        responses = [
            SimpleNamespace(
                url="https://www.pokemoncenter.com/",
                status_code=200,
                headers={"Content-Type": "text/html"},
                text="<html><title>Pokemon Center</title><main>Featured products</main></html>",
            ),
        ]
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=None)
        client.get = Mock(side_effect=responses)
        fake_httpx = SimpleNamespace(Client=Mock(return_value=client))
        browser_result = QueueDetectionResult(
            status="queue",
            evidence={"browser_rendered": True, "queue_body_markers": ["waiting room"]},
            http_status=200,
        )

        with patch.dict("sys.modules", {"httpx": fake_httpx}), \
                patch("services.pokemon_center_queue.fetch_browser_queue_status", return_value=browser_result):
            result = fetch_queue_status(browser_probe=True)

        self.assertEqual(result.status, "queue")
        self.assertTrue(result.evidence["browser_probe"]["browser_rendered"])
        self.assertEqual(client.get.call_count, 1)

    def test_browser_probe_reuses_browser_with_fresh_contexts(self):
        queue_service._BROWSER_INSTANCE = None
        queue_service._BROWSER_PLAYWRIGHT = None

        class FakeLocator:
            def count(self):
                return 1

            def inner_text(self, timeout=None):
                return "Pokemon Center featured products"

        class FakePage:
            url = "https://www.pokemoncenter.com/"

            def __init__(self):
                self.closed = False

            def on(self, event, handler):
                pass

            def goto(self, url, wait_until=None, timeout=None):
                return SimpleNamespace(status=200)

            def wait_for_timeout(self, timeout):
                pass

            def locator(self, selector):
                return FakeLocator()

            def close(self):
                self.closed = True

        class FakeContext:
            def __init__(self):
                self.page = FakePage()
                self.closed = False

            def new_page(self):
                return self.page

            def close(self):
                self.closed = True

        class FakeBrowser:
            def __init__(self):
                self.contexts = []

            def is_connected(self):
                return True

            def new_context(self, **kwargs):
                context = FakeContext()
                self.contexts.append(context)
                return context

        browser = FakeBrowser()
        fake_playwright = SimpleNamespace(
            chromium=SimpleNamespace(launch=Mock(return_value=browser)),
            stop=Mock(),
        )
        fake_sync_api = SimpleNamespace(
            TimeoutError=TimeoutError,
            sync_playwright=Mock(return_value=SimpleNamespace(start=Mock(return_value=fake_playwright))),
        )

        try:
            with patch.dict("sys.modules", {
                "playwright": SimpleNamespace(sync_api=fake_sync_api),
                "playwright.sync_api": fake_sync_api,
            }):
                first = fetch_browser_queue_status()
                second = fetch_browser_queue_status()

            self.assertEqual(first.status, "normal")
            self.assertEqual(second.status, "normal")
            self.assertEqual(fake_playwright.chromium.launch.call_count, 1)
            self.assertEqual(len(browser.contexts), 2)
            self.assertTrue(all(context.closed for context in browser.contexts))
            self.assertTrue(all(context.page.closed for context in browser.contexts))
        finally:
            queue_service._close_browser_runtime()


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

    def test_manual_queue_check_requests_browser_probe(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        result = QueueDetectionResult(status="normal", evidence={}, http_status=200)

        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result) as fetch:
            response = check_pokemon_center_queue(self.db, force=True)

        fetch.assert_called_once_with(browser_probe=True)
        self.assertTrue(response["evidence"]["browser_probe_requested"])
        self.assertEqual(response["evidence"]["browser_probe_reason"], "manual_check")

    def test_scheduled_queue_check_throttles_browser_probe(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        self.db.add(Setting(key="pokemon_center_queue_last_browser_probe_at", value=datetime.datetime.utcnow().isoformat()))
        self.db.commit()
        result = QueueDetectionResult(status="normal", evidence={}, http_status=200)

        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result) as fetch:
            response = check_pokemon_center_queue(self.db)

        fetch.assert_called_once_with(browser_probe=False)
        self.assertFalse(response["evidence"]["browser_probe_requested"])
        self.assertEqual(response["evidence"]["browser_probe_reason"], "scheduled_throttled")

    def test_scheduled_queue_check_requests_due_browser_probe(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        old_probe = datetime.datetime.utcnow() - datetime.timedelta(minutes=10)
        self.db.add(Setting(key="pokemon_center_queue_last_browser_probe_at", value=old_probe.isoformat()))
        self.db.commit()
        result = QueueDetectionResult(
            status="normal",
            evidence={"browser_probe": {"browser_probe_executed": True}},
            http_status=200,
        )

        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result) as fetch:
            response = check_pokemon_center_queue(self.db)

        fetch.assert_called_once_with(browser_probe=True)
        self.assertTrue(response["evidence"]["browser_probe_requested"])
        self.assertEqual(response["evidence"]["browser_probe_reason"], "scheduled_due")
        row = self.db.query(Setting).filter(Setting.key == "pokemon_center_queue_last_browser_probe_at").one()
        self.assertGreater(datetime.datetime.fromisoformat(row.value), old_probe)

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

    def test_failed_queue_notification_does_not_start_cooldown(self):
        self._setting(self.trainer, "pokemon_center_queue_alerts_enabled", "true")
        self._setting(self.trainer, "telegram_bot_token", "token")
        self._setting(self.trainer, "telegram_chat_id", "123")
        self.db.add(PokemonCenterQueueStatus(status="bot_protection"))
        self.db.commit()
        result = QueueDetectionResult(
            status="queue",
            evidence={"browser_rendered": True, "queue_body_markers": ["waiting room"]},
            http_status=200,
        )

        with patch("services.pokemon_center_queue.fetch_queue_status", return_value=result), \
                patch("services.pokemon_center_queue._notify_queue_started", Mock(return_value=0)):
            response = check_pokemon_center_queue(self.db)

        self.assertEqual(response["notified_count"], 0)
        self.assertIsNone(response["notified_at"])
        row = self.db.query(PokemonCenterQueueStatus).one()
        self.assertIsNone(row.notified_at)


if __name__ == "__main__":
    unittest.main()
