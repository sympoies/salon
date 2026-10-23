"""Protect the gate against clean worktrees containing committed whitespace."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


checker = Path(__file__).with_name("check-whitespace.py")


class WhitespaceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="salon-whitespace-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        self.git("init", "--quiet", "-b", "main")
        self.commit("clean\n")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.git("update-ref", "refs/remotes/origin/main", self.base)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=self.env, text=True)

    def commit(self, text):
        (self.root / "example.txt").write_text(text)
        self.git("add", "example.txt")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Fixture change")

    def check(self, event=None):
        env = dict(self.env)
        if event is not None:
            path = self.root / "event.json"
            path.write_text(json.dumps(event))
            env["GITHUB_EVENT_PATH"] = str(path)
        return subprocess.run(["python3", str(checker)], cwd=self.root, env=env, text=True, capture_output=True)

    def test_clean_feature_commit_passes(self):
        self.commit("clean successor\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_committed_branch_whitespace_fails_with_a_clean_worktree(self):
        self.commit("bad" + " " + "\n")
        self.assertEqual(self.git("diff", "HEAD", "--check"), "")
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("trailing whitespace", result.stdout + result.stderr)

    def test_ci_checks_pr_base_and_main_push_before_commit(self):
        self.commit("bad" + " " + "\n")
        self.git("update-ref", "refs/remotes/origin/main", self.git("rev-parse", "HEAD").strip())
        for event in [{"pull_request": {"base": {"sha": self.base}}}, {"before": self.base}]:
            with self.subTest(event=event):
                result = self.check(event)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("trailing whitespace", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
