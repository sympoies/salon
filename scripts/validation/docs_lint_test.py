"""Exercise the shared lint through both documentation-only gate routes."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class DocsLintGateTest(unittest.TestCase):
    def test_documentation_gate_rejects_bad_prose_and_accepts_maintained_docs(self):
        with tempfile.TemporaryDirectory(prefix="salon-docs-") as directory:
            root = Path(directory)
            for name in [".agents/scripts/pre-pr.sh", "scripts/validate-project-dev.sh",
                         "scripts/install-docs-lint.sh", "scripts/docs-lint.sh",
                         "scripts/validation/docs-lint-files.txt"]:
                source = ROOT / name
                if source.exists():
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(source, target)
            # Unrelated cheap checks are stubbed; the shared lint and gate are real.
            tools = root / "bin"
            tools.mkdir()
            for name in ["python3", "git", "shellcheck", "devlog"]:
                tool = tools / name
                tool.write_text("#!/bin/sh\nexit 1\n" if name == "git" else "#!/bin/sh\nexit 0\n")
                tool.chmod(0o755)
            (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            manifest = ROOT / "scripts/validation/docs-lint-files.txt"
            names = manifest.read_text().splitlines() if manifest.exists() else ["README.md"]
            for name in names:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / name, target)
            # Excluded historical content must not be picked up recursively.
            excluded = root / "docs/devlog/fixture.md"
            excluded.parent.mkdir(parents=True, exist_ok=True)
            bad = "# Fixture\n\n" + "A long prose sentence. " * 40 + "\n"
            excluded.write_text(bad)
            env = os.environ | {"PATH": f"{tools}:{os.environ['PATH']}"}
            readme = root / "README.md"
            clean = readme.read_text()
            for args in [["--scope", "docs"], ["--suite", "cheap"]]:
                with self.subTest(args=args):
                    readme.write_text(bad)
                    result = subprocess.run(["bash", ".agents/scripts/pre-pr.sh", *args],
                                            cwd=root, env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("HUM002", result.stderr)
                    readme.write_text(clean)
                    result = subprocess.run(["bash", ".agents/scripts/pre-pr.sh", *args],
                                            cwd=root, env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertFalse((root / ".cache/agent-validation/project-dev.ok").exists())


if __name__ == "__main__":
    unittest.main()
