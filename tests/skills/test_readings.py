"""Portable, read-only readings CLI tests; no application-store imports."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "learnharness" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import readings


def snapshot(root):
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else None
        for path in root.rglob("*")
    }


def reading(identifier, **updates):
    value = {
        "id": identifier, "kind": "recap", "mode": "researched", "status": "ready",
        "title": f"Recap {identifier}", "anchor": {"chatId": "chat_1"},
        "snapshot": {"transcript": "secret transcript"}, "body": "## The goal\n\nBody.",
        "furtherReading": [{"title": "F", "url": "https://f.org", "why": "W"}],
        "createdAt": "2026-10-27T00:00:00Z", "updatedAt": "2026-10-27T00:00:00Z", "version": 1,
    }
    value.update(updates)
    return value


class ReadingsCliTest(unittest.TestCase):
    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = readings.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        folder = self.root / "readings"
        folder.mkdir()
        (folder / "rd_a.json").write_text(json.dumps(reading("rd_a")), encoding="utf-8")
        (folder / "rd_b.json").write_text(json.dumps(reading("rd_b", kind="primer", mode="model", createdAt="2026-10-28T00:00:00Z")), encoding="utf-8")
        (folder / "rd_new.json").write_text(json.dumps(reading("rd_new", version=2)), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_list_reports_unreadable_and_writes_nothing(self):
        before = snapshot(self.root)
        code, out, _ = self.run_cli("--data-dir", str(self.root), "--format", "json", "list")
        self.assertEqual(code, 0)
        value = json.loads(out)
        self.assertEqual([r["id"] for r in value["readings"]], ["rd_b", "rd_a"])
        self.assertEqual(value["skipped_count"], 1)
        self.assertEqual(snapshot(self.root), before)

    def test_read_omits_the_snapshot_by_default_and_labels_the_evidence(self):
        code, out, _ = self.run_cli("--data-dir", str(self.root), "read", "rd_a")
        self.assertEqual(code, 0)
        self.assertIn("not evidence of understanding", out)
        self.assertIn("## Body (verbatim)", out)
        self.assertNotIn("secret transcript", out)
        code, out, _ = self.run_cli("--data-dir", str(self.root), "--format", "json", "read", "rd_a", "--include-snapshot")
        self.assertIn("secret transcript", out)

    def test_refuses_paths_and_newer_formats(self):
        code, _, err = self.run_cli("--data-dir", str(self.root), "read", "../rd_a")
        self.assertEqual(code, 1)
        self.assertIn("reading ID", err)
        code, _, err = self.run_cli("--data-dir", str(self.root), "read", "rd_new")
        self.assertEqual(code, 1)
        self.assertIn("format 2", err)

    def test_read_renders_overview_sections_verbatim(self):
        sections = [{"heading": "The map", "body": "Parts and links.", "planNodeIds": ["limits"]}]
        (self.root / "readings" / "rd_o.json").write_text(json.dumps(reading("rd_o", kind="overview", sections=sections)), encoding="utf-8")
        code, out, _ = self.run_cli("--data-dir", str(self.root), "read", "rd_o")
        self.assertEqual(code, 0)
        self.assertIn("## Section: The map (verbatim)", out)
        self.assertIn("Plan nodes: limits", out)
        self.assertIn("Parts and links.", out)


if __name__ == "__main__":
    unittest.main()
