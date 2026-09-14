import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from fastapi import HTTPException

    from api import backup as backup_api

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


class ChunkedUpload:
    def __init__(self, payload: bytes, filename: str = "backup.sql", chunk_size: int = 3):
        self.filename = filename
        self._payload = payload
        self._position = 0
        self._chunk_size = chunk_size
        self.requested_sizes = []

    async def read(self, size: int = -1) -> bytes:
        self.requested_sizes.append(size)
        if self._position >= len(self._payload):
            return b""
        chunk_size = self._chunk_size if size < 0 else min(size, self._chunk_size)
        chunk = self._payload[self._position:self._position + chunk_size]
        self._position += len(chunk)
        return chunk


class InterruptedUpload(ChunkedUpload):
    async def read(self, size: int = -1) -> bytes:
        if self._position:
            raise OSError("upload interrupted")
        return await super().read(size)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI dependencies are not installed")
class BackupCommandTests(unittest.TestCase):
    def setUp(self):
        self.admin = SimpleNamespace(role="admin")
        self.params = {
            "user": "pokemon",
            "password": "secret",
            "host": "postgres",
            "port": "5432",
            "dbname": "pokemon_tcg",
        }
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_full_backup_excludes_only_image_cache_rows(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="full", current_user=self.admin)

        command = run.call_args.args[0]
        self.assertIn("--exclude-table-data", command)
        self.assertEqual(command[command.index("--exclude-table-data") + 1], "image_cache")
        self.assertNotIn("--exclude-table", command)

    def test_full_backup_can_include_image_cache_rows(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="full,images", current_user=self.admin)

        command = run.call_args.args[0]
        self.assertNotIn("--exclude-table-data", command)
        self.assertNotIn("--exclude-table", command)

    def test_collection_backup_includes_printing_detail_tags_and_links(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="collection", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertIn("printing_detail_tags", selected_tables)
        self.assertIn("collection_printing_detail_tags", selected_tables)

    def test_product_backup_includes_printing_detail_tags_and_links(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="products", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertIn("printing_detail_tags", selected_tables)
        self.assertIn("product_card_printing_detail_tags", selected_tables)
        self.assertIn("product_ledger_printing_detail_tags", selected_tables)

    def test_combined_partial_backup_deduplicates_shared_printing_detail_table(self):
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run", return_value=completed) as run:
            backup_api.download_backup(include="collection,products", current_user=self.admin)

        command = run.call_args.args[0]
        selected_tables = [
            command[index + 1]
            for index, argument in enumerate(command)
            if argument == "-t"
        ]
        self.assertEqual(selected_tables.count("printing_detail_tags"), 1)


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI dependencies are not installed")
class RestoreBackupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.admin = SimpleNamespace(role="admin")
        self.params = {
            "user": "pokemon",
            "password": "secret",
            "host": "postgres",
            "port": "5432",
            "dbname": "pokemon_tcg",
        }
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _patches(self, run_result):
        if isinstance(run_result, BaseException) or callable(run_result):
            run_patch = patch.object(backup_api.subprocess, "run", side_effect=run_result)
        else:
            run_patch = patch.object(backup_api.subprocess, "run", return_value=run_result)
        return (
            patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name),
            patch.object(backup_api, "get_db_params", return_value=self.params),
            run_patch,
        )

    def _remaining_files(self):
        return list(Path(self.temp_dir.name).iterdir())

    async def test_restore_is_streamed_atomic_and_stops_on_sql_errors(self):
        upload = ChunkedUpload(b"SELECT 1;", filename="BACKUP.SQL")
        captured_command = None

        def complete(command, **_kwargs):
            nonlocal captured_command
            captured_command = command
            self.assertTrue(Path(command[command.index("-f") + 1]).is_file())
            return subprocess.CompletedProcess(command, 0, "", "")

        backup_dir, params, run = self._patches(complete)
        with backup_dir, params, run:
            result = await backup_api.restore_backup(upload, current_user=self.admin)

        self.assertEqual(result, {"message": "Database restored successfully"})
        self.assertEqual(captured_command[captured_command.index("-v") + 1], "ON_ERROR_STOP=1")
        self.assertIn("--no-psqlrc", captured_command)
        self.assertIn("--single-transaction", captured_command)
        self.assertGreater(len(upload.requested_sizes), 2)
        self.assertTrue(all(size == backup_api.RESTORE_CHUNK_SIZE for size in upload.requested_sizes))
        self.assertEqual(self._remaining_files(), [])

    async def test_restore_error_removes_temporary_upload(self):
        completed = subprocess.CompletedProcess([], 1, "", "broken SQL")
        backup_dir, params, run = self._patches(completed)
        with backup_dir, params, run, self.assertRaises(HTTPException) as raised:
            await backup_api.restore_backup(ChunkedUpload(b"broken"), current_user=self.admin)

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(self._remaining_files(), [])

    async def test_restore_timeout_removes_temporary_upload(self):
        timeout = subprocess.TimeoutExpired("psql", 120)
        backup_dir, params, run = self._patches(timeout)
        with backup_dir, params, run, self.assertRaises(HTTPException) as raised:
            await backup_api.restore_backup(ChunkedUpload(b"SELECT 1;"), current_user=self.admin)

        self.assertEqual(raised.exception.detail, "Restore timed out")
        self.assertEqual(self._remaining_files(), [])

    async def test_missing_psql_removes_temporary_upload(self):
        backup_dir, params, run = self._patches(FileNotFoundError())
        with backup_dir, params, run, self.assertRaises(HTTPException) as raised:
            await backup_api.restore_backup(ChunkedUpload(b"SELECT 1;"), current_user=self.admin)

        self.assertEqual(raised.exception.detail, "psql not found")
        self.assertEqual(self._remaining_files(), [])

    async def test_empty_restore_is_rejected_without_running_psql(self):
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(HTTPException) as raised:
            await backup_api.restore_backup(ChunkedUpload(b""), current_user=self.admin)

        self.assertEqual(raised.exception.status_code, 400)
        run_mock.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_missing_filename_is_rejected_without_creating_a_file(self):
        upload = ChunkedUpload(b"SELECT 1;", filename=None)
        with patch.object(backup_api, "BACKUP_DIR", self.temp_dir.name), \
             patch.object(backup_api, "get_db_params", return_value=self.params), \
             patch.object(backup_api.subprocess, "run") as run, \
             self.assertRaises(HTTPException) as raised:
            await backup_api.restore_backup(upload, current_user=self.admin)

        self.assertEqual(raised.exception.status_code, 400)
        run.assert_not_called()
        self.assertEqual(self._remaining_files(), [])

    async def test_interrupted_upload_removes_partial_file(self):
        upload = InterruptedUpload(b"SELECT 1;", chunk_size=3)
        backup_dir, params, run = self._patches(subprocess.CompletedProcess([], 0, "", ""))
        with backup_dir, params, run as run_mock, self.assertRaises(OSError):
            await backup_api.restore_backup(upload, current_user=self.admin)

        run_mock.assert_not_called()
        self.assertEqual(self._remaining_files(), [])


if __name__ == "__main__":
    unittest.main()
