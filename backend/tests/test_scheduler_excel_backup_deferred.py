"""Regression guard for manual-only workbook exports during refinement."""

import ast
from pathlib import Path
import unittest


class SchedulerWorkbookBackupTests(unittest.TestCase):
    def test_start_scheduler_does_not_register_excel_backup_job(self):
        source = (Path(__file__).parents[1] / "services" / "scheduler.py").read_text(encoding="utf-8")
        module = ast.parse(source)
        start_scheduler = next(
            node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "start_scheduler"
        )
        job_ids = [
            keyword.value.value
            for node in ast.walk(start_scheduler)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "add_job"
            for keyword in node.keywords
            if keyword.arg == "id" and isinstance(keyword.value, ast.Constant)
        ]

        self.assertNotIn("gfs_excel_backup_job", job_ids)
        self.assertIn("Excel workbook backups deferred (manual export only)", source)
