import tempfile
import unittest
from pathlib import Path

from datetime import date

from services.weekly_excel_backup import (
    GFS_RETENTION,
    _gfs_tiers_for_date,
    _prune_user_backups,
    _safe_username,
)


class WeeklyExcelBackupTests(unittest.TestCase):
    def test_safe_username_keeps_filenames_local_and_readable(self):
        self.assertEqual(_safe_username("John John / PC"), "John_John___PC")
        self.assertEqual(_safe_username(""), "user")

    def test_prunes_to_eight_newest_user_backups(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for index in range(10):
                path = directory / f"john-johns-pc-1-john-{index:02d}.xlsx"
                path.write_bytes(b"xlsx")

            removed = _prune_user_backups(directory, "1-john", keep=8)
            remaining = sorted(path.name for path in directory.glob("*.xlsx"))

            self.assertEqual(len(removed), 2)
            self.assertEqual(len(remaining), 8)
            self.assertNotIn("john-johns-pc-1-john-00.xlsx", remaining)
            self.assertNotIn("john-johns-pc-1-john-01.xlsx", remaining)

    def test_gfs_tiers_and_retention_match_the_backup_schedule(self):
        self.assertEqual(_gfs_tiers_for_date(date(2026, 7, 28)), ["sons"])
        self.assertEqual(_gfs_tiers_for_date(date(2026, 7, 27)), ["sons", "fathers"])
        self.assertEqual(
            _gfs_tiers_for_date(date(2026, 6, 1)),
            ["sons", "fathers", "grandfathers"],
        )
        self.assertEqual(GFS_RETENTION, {"sons": 7, "fathers": 4, "grandfathers": 12})
