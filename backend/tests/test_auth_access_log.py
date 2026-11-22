"""Unit tests for the OIDC access-log redaction filter.

Uvicorn logs ``'%s - "%s %s HTTP/%s" %d'`` with the request target (path plus
query) as the third argument. The filter must strip the query only for OIDC
paths and leave every other request untouched.
"""
import logging
import unittest

from services.access_log import (
    OIDC_LOG_PATH_PREFIX,
    OidcAccessLogRedactionFilter,
    install_oidc_access_log_redaction,
)


def _record(path: str, *, method: str = "GET", status: int = 200) -> logging.LogRecord:
    """Build a uvicorn-style access record for ``path``."""
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", method, path, "1.1", status),
        exc_info=None,
    )
    return record


class OidcAccessLogRedactionFilterTests(unittest.TestCase):
    def setUp(self):
        self.filter = OidcAccessLogRedactionFilter()

    def _logged_target(self, record):
        self.filter.filter(record)
        # args: (client, method, path, version, status)
        return record.args[2]

    def test_oidc_callback_query_is_stripped(self):
        record = _record(
            "/api/auth/oidc/callback?code=synthetic-code&state=synthetic-state"
        )
        self.assertEqual(
            self._logged_target(record), "/api/auth/oidc/callback"
        )

    def test_every_oidc_path_is_redacted(self):
        for path in (
            f"{OIDC_LOG_PATH_PREFIX}/start?foo=bar",
            f"{OIDC_LOG_PATH_PREFIX}/complete?token=synthetic",
            f"{OIDC_LOG_PATH_PREFIX}/link?x=1",
        ):
            with self.subTest(path=path):
                record = _record(path, method="POST")
                self.assertEqual(self._logged_target(record), path.split("?", 1)[0])

    def test_non_oidc_requests_keep_their_query_string(self):
        for path in (
            "/api/cards?search=pikachu&limit=20",
            "/api/auth/login",
            "/api/auth/me?expand=settings",
            "/api/auth/oidcish?x=1",
            "/dashboard?tab=prices",
        ):
            with self.subTest(path=path):
                record = _record(path)
                self.assertEqual(self._logged_target(record), path)

    def test_oidc_path_without_query_is_unchanged(self):
        record = _record("/api/auth/oidc/identity")
        self.assertEqual(self._logged_target(record), "/api/auth/oidc/identity")

    def test_record_with_unexpected_args_is_left_alone(self):
        record = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg="startup complete",
            args=(),
            exc_info=None,
        )
        self.assertTrue(self.filter.filter(record))
        self.assertEqual(record.args, ())

    def test_filter_is_installed_on_uvicorn_access_logger(self):
        install_oidc_access_log_redaction()
        install_oidc_access_log_redaction()
        filters = [
            existing
            for existing in logging.getLogger("uvicorn.access").filters
            if isinstance(existing, OidcAccessLogRedactionFilter)
        ]
        self.assertEqual(len(filters), 1)

    def test_installed_filter_redacts_through_a_real_handler(self):
        logger = logging.getLogger("uvicorn.access")
        install_oidc_access_log_redaction()
        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        handler = _Capture()
        previous_level = logger.level
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        try:
            logger.info(
                '%s - "%s %s HTTP/%s" %d',
                "127.0.0.1:1234",
                "GET",
                "/api/auth/oidc/callback?code=SECRET_CODE&state=SECRET_STATE",
                "1.1",
                302,
            )
            logger.info(
                '%s - "%s %s HTTP/%s" %d',
                "127.0.0.1:1234",
                "GET",
                "/api/cards?search=SECRET_QUERY",
                "1.1",
                200,
            )
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous_level)

        self.assertEqual(len(records), 2)
        self.assertIn("/api/auth/oidc/callback", records[0])
        self.assertNotIn("SECRET_CODE", records[0])
        self.assertNotIn("SECRET_STATE", records[0])
        self.assertNotIn("?", records[0])
        self.assertIn("/api/cards?search=SECRET_QUERY", records[1])


if __name__ == "__main__":
    unittest.main()
