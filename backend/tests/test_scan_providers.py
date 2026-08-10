import asyncio
import os
import unittest
from contextlib import nullcontext
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import User, UserSetting
    from services import scan_providers
    from services.scan_providers import (
        DEFAULT_OPENAI_BASE_URL,
        GEMINI,
        OPENAI,
        ScanProvider,
        extract_openai_text,
        get_provider,
        image_part,
        openai_base_url,
        openai_chat_completions_url,
        openai_requires_key,
        openai_retry_after_seconds,
        post_openai_chat,
        resolve_model,
        resolve_provider_name,
        text_part,
        visual_verification_default,
        visual_verification_enabled,
    )
    DEPS = True
except ModuleNotFoundError:
    HTTPException = Exception
    DEPS = False


LOCAL_URL = "http://127.0.0.1:11434/v1"


async def _noop_async(*_args, **_kwargs):
    return None


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.headers = headers or {}

    @property
    def is_error(self):
        return self.status_code >= 400

    def json(self):
        return self._payload


class _FakeClient:
    """Records what was sent so request shaping can be asserted."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def post(self, url, headers=None, json=None):
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        result = self._responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class _Fixture:
    """Shared setup only, deliberately not a TestCase."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="jason", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def _set(self, key, value):
        self.db.add(UserSetting(user_id=self.user.id, key=key, value=value))
        self.db.commit()


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ProviderResolutionTests(_Fixture, unittest.TestCase):

    def test_an_existing_install_with_no_setting_stays_on_gemini(self):
        # The upgrade path that matters: everyone already using this has a
        # gemini_api_key and no provider row at all.
        self._set("gemini_api_key", "AIzaSomethingSomething")
        self.assertEqual(resolve_provider_name(self.db, self.user.id), GEMINI)

    def test_choosing_openai_is_honoured(self):
        self._set("scanner_provider", "openai")
        self.assertEqual(resolve_provider_name(self.db, self.user.id), OPENAI)

    def test_an_unknown_stored_value_falls_back_rather_than_failing_a_scan(self):
        self._set("scanner_provider", "definitely-not-a-provider")
        self.assertEqual(resolve_provider_name(self.db, self.user.id), GEMINI)

    def test_no_user_resolves_to_gemini(self):
        self.assertEqual(resolve_provider_name(self.db, None), GEMINI)

    def test_the_provider_reads_its_own_credential(self):
        self._set("openai_api_key", "sk-openai-value")
        self._set("scanner_provider", "openai")
        provider = get_provider(self.db, self.user.id)
        self.assertEqual(provider.name, OPENAI)
        self.assertEqual(provider.credential(self.db, self.user.id), "sk-openai-value")


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ModelValidationTests(unittest.TestCase):
    """The stored value is exercised through the real coercion path, not written
    straight into the database as the other tests do."""

    def _coerce(self, value):
        from api.settings import _coerce_setting_value
        from services.scan_providers import SCANNER_MODEL_SETTING

        return _coerce_setting_value(SCANNER_MODEL_SETTING, value)

    def test_a_normal_model_name_is_kept(self):
        self.assertEqual(self._coerce("  gpt-5.6-luna  "), "gpt-5.6-luna")

    def test_blank_means_the_installation_default(self):
        self.assertEqual(self._coerce("   "), "")
        self.assertEqual(self._coerce(None), "")

    def test_non_text_is_rejected(self):
        for bad in ([1, 2], {"a": 1}, 42, True):
            with self.subTest(bad=bad):
                with self.assertRaises(HTTPException):
                    self._coerce(bad)

    def test_control_characters_are_rejected(self):
        for bad in ["gpt\n4o", "gpt 4o", "gpt\t4o", "../etc/passwd\x00"]:
            with self.subTest(bad=bad):
                with self.assertRaises(HTTPException):
                    self._coerce(bad)

    def test_an_overlong_name_is_rejected(self):
        with self.assertRaises(HTTPException):
            self._coerce("m" * 101)


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ModelSelectionTests(_Fixture, unittest.TestCase):
    """Users pick their own model; the installation setting is the fallback.

    The two values are deliberately different and neither is a real default, so
    these fail if precedence breaks rather than passing by coincidence.
    """

    INSTALLATION = "installation-model"
    CHOSEN = "chosen-model"

    def test_no_choice_means_the_installation_model(self):
        self._set("scanner_provider", "openai")
        with patch.dict(os.environ, {"OPENAI_MODEL": self.INSTALLATION}):
            self.assertEqual(get_provider(self.db, self.user.id).model(), self.INSTALLATION)

    def test_a_users_own_model_wins(self):
        self._set("scanner_provider", "openai")
        self._set("scanner_model", self.CHOSEN)
        with patch.dict(os.environ, {"OPENAI_MODEL": self.INSTALLATION}):
            self.assertEqual(get_provider(self.db, self.user.id).model(), self.CHOSEN)

    def test_whitespace_is_not_a_model(self):
        self._set("scanner_provider", "openai")
        self._set("scanner_model", "   ")
        with patch.dict(os.environ, {"OPENAI_MODEL": self.INSTALLATION}):
            self.assertEqual(get_provider(self.db, self.user.id).model(), self.INSTALLATION)

    def test_the_installation_model_is_reported_separately(self):
        self._set("scanner_provider", "openai")
        self._set("scanner_model", self.CHOSEN)
        with patch.dict(os.environ, {"OPENAI_MODEL": self.INSTALLATION}):
            provider = get_provider(self.db, self.user.id)
            self.assertEqual(provider.model(), self.CHOSEN)
            self.assertEqual(provider.installation_model(), self.INSTALLATION)

    def test_the_chosen_model_reaches_the_openai_request(self):
        self._set("scanner_provider", "openai")
        self._set("scanner_model", self.CHOSEN)
        provider = get_provider(self.db, self.user.id)
        client = _FakeClient([_FakeResponse(200, {"choices": [{"message": {"content": "ok"}}]})])
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL, "OPENAI_MODEL": self.INSTALLATION}):
            asyncio.run(provider.generate_text(client, "", [text_part("hi")]))
        self.assertEqual(client.calls[0]["json"]["model"], self.CHOSEN)

    def test_the_chosen_model_reaches_the_gemini_request(self):
        # Gemini puts the model in the URL, so asserting provider.model() alone
        # would not have caught the request running on the installation model
        # while diagnostics recorded the user's choice.
        self._set("scanner_model", self.CHOSEN)
        captured = {}

        async def fake_post(client, url, api_key, payload, *, max_attempts=3):
            captured["url"] = url
            return _FakeResponse(200, {
                "candidates": [{"content": {"parts": [{"text": "ok"}]}}],
            })

        provider = get_provider(self.db, self.user.id)
        with patch("api.recognize.post_gemini_generate", new=fake_post):
            with patch.dict(os.environ, {"GEMINI_MODEL": self.INSTALLATION}):
                asyncio.run(provider.generate_text(_FakeClient([]), "k", [text_part("hi")]))
        self.assertIn(self.CHOSEN, captured["url"])
        self.assertNotIn(self.INSTALLATION, captured["url"])


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class EndpointConfigurationTests(unittest.TestCase):
    """The base URL is the administrator's, never the user's."""

    def test_it_defaults_to_the_hosted_api(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENAI_BASE_URL", None)
            self.assertEqual(openai_base_url(), DEFAULT_OPENAI_BASE_URL)

    def test_a_configured_endpoint_is_used(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertEqual(openai_base_url(), LOCAL_URL)

    def test_a_trailing_slash_does_not_produce_a_double_slash(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL + "/"}):
            self.assertEqual(openai_chat_completions_url(), f"{LOCAL_URL}/chat/completions")

    def test_whitespace_is_not_a_configured_endpoint(self):
        # A value of spaces is truthy, so stripping has to happen before the
        # fallback or the base URL silently becomes empty.
        with patch.dict(os.environ, {"OPENAI_BASE_URL": "   "}):
            self.assertEqual(openai_base_url(), DEFAULT_OPENAI_BASE_URL)

    def test_the_hosted_api_needs_a_key_and_a_local_endpoint_does_not(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            self.assertTrue(openai_requires_key())
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertFalse(openai_requires_key())


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class RequestShapingTests(unittest.TestCase):

    def _run(self, provider, api_key, parts, responses):
        client = _FakeClient(responses)
        text, usage = asyncio.run(
            provider.generate_text(client, api_key, parts)
        )
        return client, text, usage

    def test_openai_sends_text_and_an_image_data_uri(self):
        payload = {"choices": [{"message": {"content": '{"name": "Quaxly"}'}}],
                   "usage": {"total_tokens": 12}}
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL, "OPENAI_MODEL": "moondream"}):
            client, text, usage = self._run(
                ScanProvider(OPENAI), "",
                [text_part("Describe"), image_part("image/jpeg", "QUJD")],
                [_FakeResponse(200, payload)],
            )
        sent = client.calls[0]["json"]
        self.assertEqual(sent["model"], "moondream")
        content = sent["messages"][0]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "Describe"})
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(content[1]["image_url"]["url"], "data:image/jpeg;base64,QUJD")
        self.assertEqual(text, '{"name": "Quaxly"}')
        self.assertEqual(extract_openai_text(payload), '{"name": "Quaxly"}')
        self.assertEqual(usage, {"total_tokens": 12})

    def test_no_authorization_header_when_there_is_no_key(self):
        # A local server has nothing to authenticate, and an empty bearer token
        # is worse than no header at all.
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            client, _, _ = self._run(
                ScanProvider(OPENAI), "",
                [text_part("hi")],
                [_FakeResponse(200, {"choices": [{"message": {"content": "ok"}}]})],
            )
        self.assertNotIn("Authorization", client.calls[0]["headers"])

    def test_the_key_is_sent_when_there_is_one(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            client, _, _ = self._run(
                ScanProvider(OPENAI), "sk-abc",
                [text_part("hi")],
                [_FakeResponse(200, {"choices": [{"message": {"content": "ok"}}]})],
            )
        self.assertEqual(client.calls[0]["headers"]["Authorization"], "Bearer sk-abc")

    def test_gemini_still_sends_its_own_wire_format(self):
        captured = {}

        async def fake_post(client, url, api_key, payload, *, max_attempts=3):
            captured["payload"] = payload
            return _FakeResponse(200, {
                "candidates": [{"content": {"parts": [{"text": "  hello  "}]}}],
                "usageMetadata": {"totalTokenCount": 3},
            })

        with patch("api.recognize.post_gemini_generate", new=fake_post):
            client, text, usage = self._run(
                ScanProvider(GEMINI), "AIzaKey",
                [text_part("Describe"), image_part("image/png", "QUJD")],
                [],
            )
        parts = captured["payload"]["contents"][0]["parts"]
        self.assertEqual(parts[0], {"text": "Describe"})
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")
        self.assertEqual(parts[1]["inline_data"]["data"], "QUJD")
        # Passthrough: visual verification records this text unstripped upstream,
        # so the adapter must not quietly trim it.
        self.assertEqual(text, "  hello  ")
        self.assertEqual(usage, {"totalTokenCount": 3})


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ErrorMappingTests(unittest.TestCase):

    def _call(self, responses, api_key="sk-x"):
        client = _FakeClient(responses)
        self._last_client = client
        return asyncio.run(
            post_openai_chat(client, "http://x/chat/completions", api_key, {}, max_attempts=2)
        )

    def test_a_rate_limit_surfaces_as_429_with_retry_after(self):
        with self.assertRaises(HTTPException) as caught:
            self._call([_FakeResponse(429, {"error": {"message": "slow down"}},
                                      {"retry-after": "7"})])
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers["Retry-After"], "7")
        self.assertEqual(caught.exception.retry_after_seconds, 7.0)
        # The provider's own wording stays out of the detail.
        self.assertNotIn("slow down", str(caught.exception.detail))

    def test_a_rejected_key_is_a_400_not_a_500(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            with self.assertRaises(HTTPException) as caught:
                self._call([_FakeResponse(401, {"error": {"message": "bad key"}})])
        self.assertEqual(caught.exception.status_code, 400)

    def test_an_auth_error_never_echoes_the_upstream_text(self):
        # This is the class where endpoints quote the offending credential back,
        # and the detail is persisted as a queue error and logged.
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            with self.assertRaises(HTTPException) as caught:
                self._call([_FakeResponse(401, {"error": {
                    "message": "Invalid API key: my-company-secret-value"}})])
        self.assertNotIn("my-company-secret-value", str(caught.exception.detail))

    def test_a_rate_limit_carries_the_metadata_the_queue_reads(self):
        # scan_queue pulls these by getattr; without them a rate-limited item is
        # rescheduled with no backoff at all.
        with self.assertRaises(HTTPException) as caught:
            self._call([_FakeResponse(429, {}, {"retry-after": "12"})])
        self.assertEqual(getattr(caught.exception, "retry_after_seconds", None), 12.0)
        self.assertEqual(getattr(caught.exception, "retry_reason", None), "rate_limit")

    def test_no_upstream_text_reaches_the_detail_on_any_status(self):
        # Pattern redaction can only catch shapes it knows. An arbitrary
        # credential is not a shape, so provider text is kept out of the detail
        # entirely: the detail is returned to callers, persisted as a queue
        # error and shown in job details.
        secret = "my-company-secret-value"
        for status in (429, 404, 500, 502):
            with self.subTest(status=status):
                body = {"error": {"message": f"Invalid API key: {secret}"}}
                # 502 is a transient class and is retried, so it needs a second
                # response to exhaust the attempts.
                responses = [_FakeResponse(status, body)] * 2
                with self.assertRaises(HTTPException) as caught:
                    self._call(responses)
                self.assertNotIn(secret, str(caught.exception.detail))

    def test_a_429_without_retry_after_leaves_the_delay_unset(self):
        # The queue treats any non-None value as authoritative, so 0.0 would
        # mean "retry immediately" instead of falling back to its own default.
        with self.assertRaises(HTTPException) as caught:
            self._call([_FakeResponse(429, {})])
        self.assertIsNone(getattr(caught.exception, "retry_after_seconds", "missing"))

    def test_list_content_is_joined_rather_than_returned_raw(self):
        # Some OpenAI-compatible servers answer with content parts. Returned raw
        # it would pass here and fail later on .strip() as a 500.
        text = extract_openai_text({"choices": [{"message": {"content": [
            {"type": "text", "text": "{\"name\": "},
            {"type": "text", "text": "\"Quaxly\"}"},
        ]}}]})
        self.assertEqual(text, '{"name": "Quaxly"}')

    def test_an_unexpected_content_type_is_rejected(self):
        with self.assertRaises(ValueError):
            extract_openai_text({"choices": [{"message": {"content": 42}}]})

    def test_null_content_is_an_empty_string(self):
        self.assertEqual(
            extract_openai_text({"choices": [{"message": {"content": None}}]}), ""
        )

    def test_a_malformed_success_is_a_502_not_a_500(self):
        provider = ScanProvider(OPENAI)
        client = _FakeClient([_FakeResponse(200, {"unexpected": True})])
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(provider.generate_text(client, "", [text_part("hi")]))
        self.assertEqual(caught.exception.status_code, 502)

    def test_a_rejected_gemini_model_also_points_at_settings(self):
        # A user who named their own Gemini model must not be sent after
        # GEMINI_MODEL, which only an administrator can change.
        import httpx as _httpx

        from api.recognize import post_gemini_generate

        class _Resp:
            status_code = 404
            headers = {}
            is_error = True

            def json(self):
                return {"error": {"message": "model not found"}}

        class _Client:
            async def post(self, url, headers=None, json=None):
                return _Resp()

        with patch("api.recognize.acquire_gemini_slot", new=_noop_async):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(post_gemini_generate(
                    _Client(),
                    "https://x/v1beta/models/my-own-model:generateContent",
                    "k", {}, max_attempts=1,
                ))
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("my-own-model", caught.exception.detail)
        self.assertIn("Einstellungen", caught.exception.detail)

    def test_a_missing_model_names_the_model_and_points_at_settings(self):
        # A user who set their own model must be told which one failed and where
        # to change it, not sent after an env var they cannot see.
        client = _FakeClient([_FakeResponse(404, {"error": {"message": "no such model"}})])
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(post_openai_chat(
                client, "http://x/chat/completions", "", {"model": "made-up-model"},
                max_attempts=1,
            ))
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("made-up-model", caught.exception.detail)
        self.assertIn("Settings", caught.exception.detail)

    def test_a_transient_error_is_retried_and_can_succeed(self):
        good = _FakeResponse(200, {"choices": [{"message": {"content": "ok"}}]})

        async def _no_backoff(*_args, **_kwargs):
            return None

        # Patched to a real coroutine, not a lambda delegating back to the
        # patched name, which would recurse.
        with patch("asyncio.sleep", new=_no_backoff):
            resp = self._call([_FakeResponse(503), good])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(self._last_client.calls), 2)

    def test_an_unparseable_response_is_reported_not_swallowed(self):
        with self.assertRaises(ValueError):
            extract_openai_text({"unexpected": True})


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class RateLimiterIsolationTests(_Fixture, unittest.TestCase):
    """The Gemini limiter is keyed by the API key, so a keyless provider must
    never enter it: every such user would share one bucket and one penalty."""

    def test_gemini_uses_its_priority_scope(self):
        entered = []

        class _Scope:
            def __enter__(self): entered.append(True)
            def __exit__(self, *a): return False

        with patch("services.gemini_rate_limit.gemini_priority_scope", return_value=_Scope()):
            with ScanProvider(GEMINI).rate_limit_scope("background"):
                pass
        self.assertEqual(entered, [True])

    def test_openai_does_not_enter_the_gemini_limiter(self):
        called = []
        with patch("services.gemini_rate_limit.gemini_priority_scope",
                   side_effect=lambda *a, **k: called.append(a)):
            scope = ScanProvider(OPENAI).rate_limit_scope("background")
            with scope:
                pass
        self.assertEqual(called, [])
        self.assertIsInstance(scope, type(nullcontext()))


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class VisualVerificationToggleTests(_Fixture, unittest.TestCase):

    def test_gemini_keeps_visual_verification_on_by_default(self):
        self.assertTrue(visual_verification_enabled(self.db, self.user.id, GEMINI))

    def test_a_self_hosted_endpoint_starts_with_it_off(self):
        # The multi-image comparison is beyond most small local models, and a
        # confident wrong pick is worse than no pick.
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertFalse(visual_verification_enabled(self.db, self.user.id, OPENAI))

    def test_hosted_openai_keeps_it_on(self):
        # The default follows capability, not provider name: gpt-4o does this at
        # least as well as gemini-flash, so defaulting it off would be arbitrary.
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            self.assertTrue(visual_verification_enabled(self.db, self.user.id, OPENAI))

    def test_a_user_can_turn_it_on_for_a_self_hosted_endpoint(self):
        self._set("scanner_visual_verification", "true")
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertTrue(visual_verification_enabled(self.db, self.user.id, OPENAI))

    def test_a_user_can_turn_it_off_for_gemini(self):
        self._set("scanner_visual_verification", "false")
        self.assertFalse(visual_verification_enabled(self.db, self.user.id, GEMINI))


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class CredentialGateTests(_Fixture, unittest.TestCase):

    def test_a_local_endpoint_needs_no_credential(self):
        self._set("scanner_provider", "openai")
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            provider = get_provider(self.db, self.user.id)
            self.assertFalse(provider.requires_credential())

    def test_the_hosted_api_still_needs_one(self):
        self._set("scanner_provider", "openai")
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            provider = get_provider(self.db, self.user.id)
            self.assertTrue(provider.requires_credential())
            self.assertEqual(provider.credential(self.db, self.user.id), "")

    def test_gemini_always_needs_one(self):
        self.assertTrue(ScanProvider(GEMINI).requires_credential())


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class PerUserResolutionTests(_Fixture, unittest.TestCase):
    """The background drain processes every user's jobs in one pass, so the
    provider has to be resolved per item owner. Resolving it once per drain would
    silently scan everyone with whoever happened to be first in the queue."""

    def setUp(self):
        super().setUp()
        self.other = User(username="mika", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.other)
        self.db.commit()
        self.db.add(UserSetting(user_id=self.other.id, key="scanner_provider", value="openai"))
        self.db.commit()

    def test_two_users_in_one_pass_get_their_own_provider(self):
        self.assertEqual(get_provider(self.db, self.user.id).name, GEMINI)
        self.assertEqual(get_provider(self.db, self.other.id).name, OPENAI)

    def test_resolution_is_not_cached_between_users(self):
        # Interleaved deliberately: a cached first answer would show up here.
        order = [self.user.id, self.other.id, self.user.id, self.other.id]
        names = [get_provider(self.db, uid).name for uid in order]
        self.assertEqual(names, [GEMINI, OPENAI, GEMINI, OPENAI])

    def test_each_user_gets_their_own_visual_default(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertTrue(visual_verification_enabled(self.db, self.user.id, GEMINI))
            self.assertFalse(visual_verification_enabled(self.db, self.other.id, OPENAI))


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class RetryAfterBoundsTests(unittest.TestCase):
    """A hostile or broken endpoint must not be able to stall the queue."""

    def _retry_after(self, value):
        return openai_retry_after_seconds(_FakeResponse(429, {}, {"retry-after": value}))

    def test_an_infinite_value_is_rejected(self):
        # float("1e309") is inf; int() on it raises, which surfaced as a 500
        # while building the 429 response.
        self.assertIsNone(self._retry_after("1e309"))

    def test_an_enormous_finite_value_is_capped(self):
        # 1e308 is finite, so it passed through and then overflowed timedelta in
        # the queue, leaving the item leased and aborting the drain pass.
        capped = self._retry_after("1e308")
        self.assertIsNotNone(capped)
        self.assertLessEqual(capped, 24 * 60 * 60)

    def test_a_normal_value_is_untouched(self):
        self.assertEqual(self._retry_after("30"), 30.0)

    def test_a_capped_value_still_builds_a_valid_429(self):
        client = _FakeClient([_FakeResponse(429, {}, {"retry-after": "1e308"})])
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(post_openai_chat(client, "http://x/chat/completions", "", {}, max_attempts=1))
        self.assertEqual(caught.exception.status_code, 429)
        self.assertLessEqual(caught.exception.retry_after_seconds, 24 * 60 * 60)


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class RequestRejectionTests(unittest.TestCase):

    def test_a_400_is_not_reported_as_a_credential_problem(self):
        # A rejected image must not send a user with a valid key after their key.
        client = _FakeClient([_FakeResponse(400, {"error": {"message": "bad image"}})])
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(post_openai_chat(client, "http://x/chat/completions", "sk-x", {}, max_attempts=1))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertNotIn("key", str(caught.exception.detail).lower())

    def test_a_401_still_points_at_the_key(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            client = _FakeClient([_FakeResponse(401, {})])
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(post_openai_chat(client, "http://x/chat/completions", "sk-x", {}, max_attempts=1))
        self.assertIn("key", str(caught.exception.detail).lower())


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class VisualDefaultPublicationTests(unittest.TestCase):
    """The UI must be able to show the state the scanner will actually use."""

    def test_hosted_openai_defaults_on(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": DEFAULT_OPENAI_BASE_URL}):
            self.assertTrue(visual_verification_default(OPENAI))

    def test_a_self_hosted_endpoint_defaults_off(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertFalse(visual_verification_default(OPENAI))

    def test_gemini_defaults_on_whatever_the_base_url_is(self):
        with patch.dict(os.environ, {"OPENAI_BASE_URL": LOCAL_URL}):
            self.assertTrue(visual_verification_default(GEMINI))


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class TraceRedactionTests(unittest.TestCase):
    """Upstream error text is echoed into the detail and recorded to disk, and
    some endpoints quote the offending key back at you."""

    def test_an_openai_key_is_redacted_from_a_recorded_error(self):
        from services.scan_trace import _redact_error

        message = "Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz012345"
        redacted = _redact_error(message)
        self.assertNotIn("sk-proj-abcdefghijklmnopqrstuvwxyz012345", redacted)
        self.assertIn("[REDACTED_API_KEY]", redacted)

    def test_a_gemini_key_is_still_redacted(self):
        from services.scan_trace import _redact_error

        redacted = _redact_error("key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123 failed")
        self.assertNotIn("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123", redacted)


if __name__ == "__main__":
    unittest.main()
