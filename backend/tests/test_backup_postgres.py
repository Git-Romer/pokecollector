"""Opt-in end-to-end PostgreSQL checks for backup creation and atomic restore."""

import asyncio
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    import psycopg2
    from psycopg2 import sql
    from fastapi import HTTPException

    from api import backup as backup_api
    from services.postgres_cli import parse_database_url

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


POSTGRES_TEST_ENABLED = (
    DEPS_AVAILABLE
    and os.environ.get("BACKUP_POSTGRES_TEST") == "1"
    and os.environ.get("DATABASE_URL", "").startswith(("postgresql://", "postgres://"))
    and shutil.which("pg_dump") is not None
    and shutil.which("psql") is not None
)


class ChunkedUpload:
    def __init__(self, payload: bytes, filename: str = "backup.sql"):
        self.filename = filename
        self._payload = payload
        self._position = 0

    async def read(self, size: int = -1) -> bytes:
        if self._position >= len(self._payload):
            return b""
        end = len(self._payload) if size < 0 else self._position + size
        chunk = self._payload[self._position:end]
        self._position += len(chunk)
        return chunk


@unittest.skipUnless(POSTGRES_TEST_ENABLED, "requires an isolated PostgreSQL test server")
class BackupPostgresTests(unittest.TestCase):
    def setUp(self):
        base_params = parse_database_url(os.environ["DATABASE_URL"])
        if not base_params:
            self.skipTest("DATABASE_URL is not a PostgreSQL URL")
        self.database_name = f"backup_test_{uuid.uuid4().hex}"
        self.params = {**base_params, "dbname": self.database_name}
        self.admin = SimpleNamespace(role="admin")
        self.temp_dir = tempfile.TemporaryDirectory()
        self._admin_connection = self._connect({**base_params, "dbname": "postgres"})
        self._admin_connection.autocommit = True
        with self._admin_connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(self.database_name)))
        with self._connect(self.params) as connection, connection.cursor() as cursor:
            cursor.execute("CREATE TABLE restore_marker (value TEXT NOT NULL)")
            cursor.execute("INSERT INTO restore_marker VALUES ('from-backup')")
            cursor.execute("""
                CREATE TABLE image_cache (
                    id SERIAL PRIMARY KEY,
                    image_key TEXT UNIQUE NOT NULL,
                    data BYTEA NOT NULL
                )
            """)
            cursor.execute(
                "INSERT INTO image_cache (image_key, data) VALUES (%s, %s)",
                ("cached", b"cached-image-payload"),
            )

    def tearDown(self):
        if hasattr(self, "_admin_connection"):
            with self._admin_connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()",
                    (self.database_name,),
                )
                cursor.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(self.database_name)))
            self._admin_connection.close()
        if hasattr(self, "temp_dir"):
            self.temp_dir.cleanup()

    @staticmethod
    def _connect(params):
        return psycopg2.connect(
            user=params["user"],
            password=params["password"],
            host=params["host"],
            port=params["port"],
            dbname=params["dbname"],
        )

    def _api_patches(self):
        return (
            patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name),
            patch.object(backup_api, "get_db_params", return_value=self.params),
        )

    def test_full_backup_without_images_restores_valid_empty_cache(self):
        backup_dir, params = self._api_patches()
        with backup_dir, params:
            response = backup_api.download_backup(include="full", current_user=self.admin)
            dump_path = Path(response.path)
            dump_bytes = dump_path.read_bytes()
            self.assertNotIn(b"cached-image-payload", dump_bytes)

            with self._connect(self.params) as connection, connection.cursor() as cursor:
                cursor.execute("UPDATE restore_marker SET value = 'after-backup'")
                cursor.execute(
                    "INSERT INTO image_cache (image_key, data) VALUES (%s, %s)",
                    ("later", b"later-cache"),
                )

            result = asyncio.run(
                backup_api.restore_backup(ChunkedUpload(dump_bytes), current_user=self.admin)
            )

        self.assertEqual(result, {"message": "Database restored successfully"})
        with self._connect(self.params) as connection, connection.cursor() as cursor:
            cursor.execute("SELECT value FROM restore_marker")
            self.assertEqual(cursor.fetchone()[0], "from-backup")
            cursor.execute("SELECT count(*) FROM image_cache")
            self.assertEqual(cursor.fetchone()[0], 0)
            cursor.execute(
                "INSERT INTO image_cache (image_key, data) VALUES (%s, %s) RETURNING id",
                ("rebuilt", b"x"),
            )
            self.assertGreater(cursor.fetchone()[0], 0)

    def test_sql_error_rolls_back_every_statement_and_removes_upload(self):
        broken_dump = b"""
            DELETE FROM restore_marker;
            INSERT INTO restore_marker VALUES ('partially-restored');
            SELECT 1 / 0;
        """
        backup_dir, params = self._api_patches()
        with backup_dir, params, self.assertRaises(HTTPException):
            asyncio.run(
                backup_api.restore_backup(ChunkedUpload(broken_dump), current_user=self.admin)
            )

        with self._connect(self.params) as connection, connection.cursor() as cursor:
            cursor.execute("SELECT value FROM restore_marker")
            self.assertEqual(cursor.fetchone()[0], "from-backup")
        self.assertEqual(
            [path for path in Path(self.temp_dir.name).iterdir() if path.name.startswith("restore_")],
            [],
        )


if __name__ == "__main__":
    unittest.main()
