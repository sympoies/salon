"""Acceptance fixtures for PR scope and safe reuse of full CI coverage."""

import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
from ci_scope import select_scope, selected_suites, reusable_run, duplicate_run


class ScopeTest(unittest.TestCase):
    def test_changed_path_sets(self):
        cases = [
            ([], "docs"),
            (["README.md", "docs/devlog/2026-10.md"], "docs"),
            (["docs/guide.md", "packages/edge/src/server.ts"], "edge"),
            (["packages/edge/test/server.test.ts"], "edge"),
            (["packages/ui/src/App.tsx"], "ui"),
            (["packages/ui/test/support/browserLayout.ts"], "ui"),
            (["packages/edge/src/server.ts", "packages/ui/src/App.tsx"], "full"),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(select_scope(paths), expected)
        for path in ["packages/shared/src/api.ts", "package.json", "pnpm-lock.yaml",
                     "pnpm-workspace.yaml", ".github/workflows/ci.yml", "tsconfig.scripts.json",
                     "scripts/validate-core-packages.sh", ".agents/scripts/pre-pr.sh",
                     "docs/core-source-manifest.json", "apps/workspace/src/main.ts",
                     "Dockerfile", "packages/new/src/index.ts"]:
            with self.subTest(path=path):
                self.assertEqual(select_scope([path, "docs/guide.md"]), "full")

    def test_selected_suites_follow_dependency_graph(self):
        self.assertEqual(selected_suites("docs"), [])
        self.assertEqual(selected_suites("edge"), ["core", "edge"])
        self.assertEqual(selected_suites("ui"), ["core", "ui-unit", "ui-browser"])
        self.assertEqual(selected_suites("full"), ["core", "edge", "ui-unit", "ui-browser"])

    def test_only_matching_successful_full_run_is_reused(self):
        tree = "a" * 40
        run = {"id": 10, "event": "pull_request", "conclusion": "success",
               "head_commit": {"tree_id": tree}, "head_repository": {"full_name": "example/project"}}
        job = {"name": "Core package validation", "conclusion": "success", "steps": [
            {"name": f"Full suite passed: {tree}", "conclusion": "success"}]}
        self.assertTrue(reusable_run(run, [job], tree, "example/project"))
        for change in [{"event": "push"}, {"conclusion": "failure"},
                       {"head_commit": {"tree_id": "b" * 40}},
                       {"head_repository": {"full_name": "example/fork"}}]:
            with self.subTest(change=change):
                self.assertFalse(reusable_run(run | change, [job], tree, "example/project"))
        for jobs in [[], [job | {"conclusion": "failure"}],
                     [job | {"steps": []}], [job | {"steps": [{
                         "name": f"Full suite passed: {tree}", "conclusion": "skipped"}]}],
                     [job | {"steps": [{"name": f"Full suite passed: {'b' * 40}", "conclusion": "success"}]}]]:
            with self.subTest(jobs=jobs):
                self.assertFalse(reusable_run(run, jobs, tree, "example/project"))


class NullableRunTest(unittest.TestCase):
    def test_null_run_commit_metadata_falls_back_to_full_validation(self):
        payload = {"workflow_runs": [{"head_commit": None}]}
        env = {"GITHUB_REPOSITORY": "example/project", "GITHUB_API_URL": "https://api.example.invalid",
               "GH_TOKEN": "fixture"}
        with mock.patch.dict(os.environ, env), mock.patch("ci_scope.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            self.assertEqual(duplicate_run("a" * 40), "")

    def test_null_provenance_is_never_reusable(self):
        tree = "a" * 40
        run = {"event": "pull_request", "conclusion": "success", "head_commit": {"tree_id": tree},
               "head_repository": {"full_name": "example/project"}}
        jobs = [{"name": "Core package validation", "conclusion": "success", "steps": [
            {"name": f"Full suite passed: {tree}", "conclusion": "success"}]}]
        for field in ["head_commit", "head_repository"]:
            with self.subTest(field=field):
                self.assertFalse(reusable_run(run | {field: None}, jobs, tree, "example/project"))


class MergeBaseTest(unittest.TestCase):
    def test_deleted_and_renamed_paths_are_scoped_from_merge_base(self):
        with tempfile.TemporaryDirectory(prefix="salon-scope-", dir="/tmp") as directory:
            root = Path(directory)
            env = {"PATH": os.environ["PATH"], "HOME": directory,
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, env=env, text=True).strip()

            def commit():
                git("add", ".")
                git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
                    "commit", "--quiet", "-m", "Fixture change")

            def scope(base):
                return subprocess.check_output(["python3", str(Path(__file__).with_name("ci_scope.py")),
                                                "--base", base], cwd=root, env=env, text=True).strip()

            git("init", "--quiet", "-b", "main")
            edge = root / "packages/edge/fixture.ts"
            edge.parent.mkdir(parents=True)
            edge.write_text("export const fixture = 1;\n")
            (root / "README.md").write_text("Fixture\n")
            commit()
            base = git("rev-parse", "HEAD")
            git("checkout", "--quiet", "-b", "base-advance")
            (root / "pnpm-lock.yaml").write_text("Fixture\n")
            commit()
            advanced = git("rev-parse", "HEAD")
            git("checkout", "--quiet", "-b", "feature", base)
            edge.unlink()
            commit()
            self.assertEqual(scope(advanced), "edge")
            git("checkout", "--quiet", "-b", "move", base)
            target = root / "packages/ui/fixture.ts"
            target.parent.mkdir(parents=True)
            edge.rename(target)
            commit()
            self.assertEqual(scope(base), "full")


if __name__ == "__main__":
    unittest.main()
