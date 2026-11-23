import base64
import datetime
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import MagicMock, patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker

    from api import push as push_api
    from database import Base
    from models import Card, PushSubscription, User, WishlistItem
    from services import push as push_service
    from services import sync_service
    DEPS_AVAILABLE = push_service.webpush is not None
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

APPLE = "https://web.push.apple.com/QAbc123"
FCM = "https://fcm.googleapis.com/fcm/send/abc"
MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/abc"
WINDOWS = "https://db5p.notify.windows.com/w/?token=abc"


def web_push_error(status):
    exc = push_service.WebPushException("push failed")
    exc.response = MagicMock(status_code=status) if status is not None else None
    return exc


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy/pywebpush are not installed in this lightweight test environment")
class PushEndpointValidationTests(unittest.TestCase):
    def test_accepts_known_push_services(self):
        for endpoint in (APPLE, FCM, MOZILLA, WINDOWS, "https://web.push.apple.com:443/x"):
            self.assertEqual(push_service.validate_push_endpoint(endpoint), endpoint)

    def test_rejects_unsafe_endpoints(self):
        rejected = [
            "http://web.push.apple.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://8.8.8.8/x",
            "https://example.com/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilfcm.googleapis.com/x",
            "https://evil-push.apple.com/x",
            "https://web.push.apple.com:8443/x",
            "https://user:pw@web.push.apple.com/x",
            "https://localhost/x",
            "ftp://web.push.apple.com/x",
            "",
            "https://web.push.apple.com/" + "a" * 2100,
        ]
        for endpoint in rejected:
            with self.assertRaises(ValueError, msg=endpoint):
                push_service.validate_push_endpoint(endpoint)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy/pywebpush are not installed in this lightweight test environment")
class VapidKeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        key_file = os.path.join(self.tmp.name, "auth", "vapid_private.pem")
        self.env = patch.dict(os.environ, {"VAPID_PRIVATE_KEY_FILE": key_file}, clear=False)
        self.env.start()
        os.environ.pop("VAPID_PRIVATE_KEY", None)
        self.key_file = key_file
        push_service._reset_vapid_cache()

    def tearDown(self):
        push_service._reset_vapid_cache()
        self.env.stop()
        self.tmp.cleanup()

    def test_creates_private_key_file_with_mode_0600_and_reuses_it(self):
        _vapid, public = push_service.get_or_create_vapid_keys()
        self.assertTrue(os.path.exists(self.key_file))
        self.assertEqual(stat.S_IMODE(os.stat(self.key_file).st_mode), 0o600)

        raw = base64.urlsafe_b64decode(public + "=" * (-len(public) % 4))
        self.assertEqual(len(raw), 65)
        self.assertEqual(raw[0], 4)

        push_service._reset_vapid_cache()
        _again, public_again = push_service.get_or_create_vapid_keys()
        self.assertEqual(public, public_again)

    def test_environment_key_wins_over_the_file(self):
        _vapid, public = push_service.get_or_create_vapid_keys()
        with open(self.key_file, "r", encoding="ascii") as fh:
            pem = fh.read()
        os.remove(self.key_file)
        push_service._reset_vapid_cache()
        with patch.dict(os.environ, {"VAPID_PRIVATE_KEY": pem.replace("\n", "\\n")}):
            _vapid, from_env = push_service.get_or_create_vapid_keys()
        self.assertEqual(from_env, public)
        self.assertFalse(os.path.exists(self.key_file))

    def test_default_subject_can_sign_a_vapid_header(self):
        vapid, _public = push_service.get_or_create_vapid_keys()
        for subject in (push_service.DEFAULT_VAPID_SUBJECT, "mailto:me@example.com"):
            headers = vapid.sign({"sub": subject, "aud": "https://web.push.apple.com"})
            self.assertTrue(headers["Authorization"].startswith("vapid "))

    def test_private_key_is_not_logged(self):
        with self.assertLogs("services.push", level="INFO") as logs:
            push_service.get_or_create_vapid_keys()
        with open(self.key_file, "r", encoding="ascii") as fh:
            body = "".join(line for line in fh.read().splitlines() if "KEY" not in line)
        self.assertNotIn(body, "\n".join(logs.output))


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy/pywebpush are not installed in this lightweight test environment")
class PushDatabaseTestCase(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add_all([self.user, self.other])
        self.db.commit()
        patcher = patch.object(push_service, "get_or_create_vapid_keys", return_value=(object(), "pub"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.db.close()

    def add_sub(self, user=None, endpoint=APPLE, failures=0):
        sub = PushSubscription(
            user_id=(user or self.user).id, endpoint=endpoint, p256dh="p", auth="a", failure_count=failures
        )
        self.db.add(sub)
        self.db.commit()
        return sub

    def subs(self):
        return self.db.query(PushSubscription).all()


class PushPayloadTests(PushDatabaseTestCase):
    def test_test_notification_describes_the_message_without_repeating_app_name(self):
        self.add_sub()
        with patch.object(push_service, "webpush") as sender:
            result = push_service.send_test(self.db, self.user.id)
        self.assertEqual(result, {"sent": 1, "removed": 0})
        notification = json.loads(sender.call_args.kwargs["data"])["notification"]
        self.assertEqual(notification, {
            "title": "Test notification",
            "body": "Notifications are working on this device.",
            "navigate": "/wishlist",
        })

    def test_payload_is_declarative_web_push_json_without_prices(self):
        payload = json.loads(push_service.build_price_alert_payload("Pikachu"))
        self.assertEqual(payload["web_push"], 8030)
        self.assertEqual(payload["notification"]["navigate"], "/wishlist")
        self.assertEqual(payload["notification"]["title"], "Wishlist price alert")
        self.assertEqual(payload["notification"]["body"], "Pikachu")

    def test_payload_never_exceeds_4_kb_even_for_huge_or_multibyte_names(self):
        for name in ("x" * 50000, "é" * 5000, "🃏" * 3000, ""):
            payload = push_service.build_price_alert_payload(name)
            self.assertLessEqual(len(payload.encode("utf-8")), 4096)
            json.loads(payload)

    def test_oversized_payload_is_refused(self):
        self.add_sub()
        with patch.object(push_service, "webpush") as sender:
            with self.assertRaises(ValueError):
                push_service.send_to_user(self.db, self.user.id, {"x": "y" * 5000})
        sender.assert_not_called()


class PushSendOutcomeTests(PushDatabaseTestCase):
    def send(self, side_effect=None):
        with patch.object(push_service, "webpush", side_effect=side_effect) as sender:
            result = push_service.send_to_user(self.db, self.user.id, {"x": 1})
        return result, sender

    def test_success_records_timestamp_and_resets_failures(self):
        self.add_sub(failures=3)
        result, sender = self.send()
        self.assertEqual(result, {"sent": 1, "removed": 0})
        sub = self.subs()[0]
        self.assertIsNotNone(sub.last_success_at)
        self.assertEqual(sub.failure_count, 0)
        kwargs = sender.call_args.kwargs
        self.assertEqual(kwargs["ttl"], 86400)
        self.assertEqual(kwargs["headers"], {"Urgency": "normal"})
        self.assertEqual(kwargs["timeout"], 10)
        self.assertEqual(kwargs["subscription_info"]["endpoint"], APPLE)

    def test_410_and_404_remove_the_subscription(self):
        for status in (410, 404):
            self.add_sub(endpoint=f"{APPLE}/{status}")
            result, _ = self.send(web_push_error(status))
            self.assertEqual(result["removed"], 1)
            self.assertEqual(self.subs(), [])

    def test_403_keeps_the_subscription_without_counting_a_failure(self):
        self.add_sub()
        result, _ = self.send(web_push_error(403))
        self.assertEqual(result, {"sent": 0, "removed": 0})
        self.assertEqual(self.subs()[0].failure_count, 0)

    def test_429_skips(self):
        self.add_sub()
        result, _ = self.send(web_push_error(429))
        self.assertEqual(result, {"sent": 0, "removed": 0})
        self.assertEqual(self.subs()[0].failure_count, 0)

    def test_other_failures_count_and_the_tenth_removes(self):
        self.add_sub()
        result, _ = self.send(web_push_error(500))
        self.assertEqual(result, {"sent": 0, "removed": 0})
        self.assertEqual(self.subs()[0].failure_count, 1)

        self.subs()[0].failure_count = 9
        self.db.commit()
        result, _ = self.send(ConnectionError("boom"))
        self.assertEqual(result["removed"], 1)
        self.assertEqual(self.subs(), [])

    def test_only_the_users_own_subscriptions_are_used(self):
        self.add_sub()
        self.add_sub(user=self.other, endpoint=FCM)
        _, sender = self.send()
        self.assertEqual(sender.call_count, 1)

    def test_no_subscriptions_means_no_send_and_no_key_creation(self):
        with patch.object(push_service, "webpush") as sender:
            result = push_service.send_to_user(self.db, self.user.id, {"x": 1})
        self.assertEqual(result, {"sent": 0, "removed": 0})
        sender.assert_not_called()
        push_service.get_or_create_vapid_keys.assert_not_called()


class PushApiTests(PushDatabaseTestCase):
    def body(self, endpoint=APPLE, **extra):
        return push_api.PushSubscribeRequest(endpoint=endpoint, keys=push_api.PushKeys(p256dh="p", auth="a"), **extra)

    def test_subscribe_creates_and_upserts_by_endpoint_reassigning_the_owner(self):
        first = push_api.subscribe(self.body(user_agent="UA"), current_user=self.user, db=self.db)
        sub = self.subs()[0]
        sub.failure_count = 4
        self.db.commit()

        second = push_api.subscribe(self.body(), current_user=self.other, db=self.db)
        self.assertEqual(first["id"], second["id"])
        sub = self.subs()[0]
        self.assertEqual(len(self.subs()), 1)
        self.assertEqual(sub.user_id, self.other.id)
        self.assertEqual(sub.failure_count, 0)

    def test_subscribe_rejects_foreign_hosts_with_422(self):
        for endpoint in ("http://web.push.apple.com/x", "https://10.0.0.1/x", "https://example.com/x"):
            with self.assertRaises(HTTPException) as ctx:
                push_api.subscribe(self.body(endpoint), current_user=self.user, db=self.db)
            self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(self.subs(), [])

    def test_user_agent_is_truncated(self):
        push_api.subscribe(self.body(user_agent="u" * 900), current_user=self.user, db=self.db)
        self.assertEqual(len(self.subs()[0].user_agent), 255)

    def test_unsubscribe_only_removes_the_callers_rows(self):
        self.add_sub()
        push_api.unsubscribe(push_api.PushUnsubscribeRequest(endpoint=APPLE), current_user=self.other, db=self.db)
        self.assertEqual(len(self.subs()), 1)
        response = push_api.unsubscribe(push_api.PushUnsubscribeRequest(endpoint=APPLE), current_user=self.user, db=self.db)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.subs(), [])

    def test_vapid_public_key_route(self):
        self.assertEqual(push_api.get_vapid_public_key(current_user=self.user), {"public_key": "pub"})

    def test_test_route_reports_sent_and_removed(self):
        self.add_sub()
        self.add_sub(endpoint=FCM)
        with patch.object(push_service, "webpush", side_effect=[None, web_push_error(410)]):
            result = push_api.send_test_notification(current_user=self.user, db=self.db)
        self.assertEqual(result, {"sent": 1, "removed": 1})

    def test_router_routes_are_registered_and_authenticated(self):
        routes = {(route.path, tuple(sorted(route.methods))) for route in push_api.router.routes}
        self.assertEqual(routes, {
            ("/vapid-public-key", ("GET",)),
            ("/subscribe", ("POST",)),
            ("/subscribe", ("DELETE",)),
            ("/test", ("POST",)),
        })
        for route in push_api.router.routes:
            names = [dep.call.__name__ for dep in route.dependant.dependencies]
            self.assertIn("get_current_user", names)

    def test_deleting_a_user_cascades_to_subscriptions(self):
        self.add_sub()
        self.add_sub(user=self.other, endpoint=FCM)
        self.db.delete(self.user)
        self.db.commit()
        self.assertEqual([s.endpoint for s in self.subs()], [FCM])


class PushAlertHookTests(PushDatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.card = Card(
            id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en",
            variants_normal=True,
        )
        self.db.add(self.card)
        self.db.commit()
        self.item = WishlistItem(user_id=self.user.id, card_id=self.card.id, price_alert_above=1.0, quantity=1)
        self.db.add(self.item)
        self.db.commit()
        for name, value in (
            ("effective_market_price", 5.0),
            ("_user_price_field", "price_market"),
        ):
            patcher = patch.object(sync_service, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_alert_sends_telegram_and_push(self):
        with patch.object(sync_service.telegram, "send_price_alert") as telegram_alert, \
                patch.object(sync_service.push, "send_price_alert") as push_alert:
            sync_service.check_wishlist_alerts(self.db, [self.card.id])
        telegram_alert.assert_called_once()
        push_alert.assert_called_once_with(self.db, self.user.id, "Sprigatito", 5.0, 1.0, "above")
        self.assertIsNotNone(self.db.get(WishlistItem, self.item.id).notified_at)

    def test_push_failure_does_not_break_telegram_or_notified_at(self):
        with patch.object(sync_service.telegram, "send_price_alert") as telegram_alert, \
                patch.object(sync_service.push, "send_price_alert", side_effect=RuntimeError("boom")):
            sync_service.check_wishlist_alerts(self.db, [self.card.id])
        telegram_alert.assert_called_once()
        self.assertIsNotNone(self.db.get(WishlistItem, self.item.id).notified_at)

    def test_no_alert_means_no_push(self):
        self.item.notified_at = datetime.datetime.utcnow()
        self.db.commit()
        with patch.object(sync_service.telegram, "send_price_alert"), \
                patch.object(sync_service.push, "send_price_alert") as push_alert:
            sync_service.check_wishlist_alerts(self.db, [self.card.id])
        push_alert.assert_not_called()


if __name__ == "__main__":
    unittest.main()
