"""Run the workflow's devlog bootstrap with real fixture digests and fake transport."""

from hashlib import sha256
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest


workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"


class DevlogBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="salon-devlog-bootstrap-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.binary = b"#!/bin/bash\nprintf 'devlog 1.31.16\\n'\n"
        self.archive = self.root / "fixture.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            item = tarfile.TarInfo("nils-cli-v1.31.16-x86_64-unknown-linux-gnu/bin/devlog")
            item.size = len(self.binary)
            item.mode = 0o755
            archive.addfile(item, io.BytesIO(self.binary))
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", RUNNER_TEMP=str(self.root),
                        GITHUB_PATH=str(self.root / "github-path"), GITHUB_STEP_SUMMARY=str(self.root / "summary"),
                        DEVLOG_ARCHIVE_URL="https://example.invalid/devlog.tar.gz",
                        DEVLOG_ARCHIVE_SHA256=sha256(self.archive.read_bytes()).hexdigest(),
                        DEVLOG_BINARY_SHA256=sha256(self.binary).hexdigest(), FIXTURE_ARCHIVE=str(self.archive))
        for name in ["github-path", "summary", "calls"]:
            (self.root / name).touch()
        # Only the platform/network transports are replaced. Checks compare
        # actual fixture bytes and the workflow's exact shell program executes.
        for name, code in {
            "curl": '''import os, pathlib, shutil, sys
root = pathlib.Path(os.environ["RUNNER_TEMP"])
with (root / "calls").open("a") as calls: print("curl", file=calls)
shutil.copyfile(os.environ["FIXTURE_ARCHIVE"], sys.argv[sys.argv.index("--output") + 1])
''',
            "sha256sum": '''import hashlib, pathlib, sys
expected, path = sys.stdin.read().strip().split("  ", 1)
try: actual = hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
except OSError: sys.exit(1)
sys.exit(0 if actual == expected else 1)
''',
            "tar": '''import os, pathlib, sys, tarfile
root = pathlib.Path(os.environ["RUNNER_TEMP"])
with (root / "calls").open("a") as calls: print("tar", file=calls)
with tarfile.open(sys.argv[sys.argv.index("-xzf") + 1]) as archive:
    source = next(item for item in archive.getmembers() if item.name.endswith("/bin/devlog"))
    target = pathlib.Path(sys.argv[sys.argv.index("-C") + 1]) / "devlog"
    target.write_bytes(archive.extractfile(source).read())
    target.chmod(0o755)
''',
        }.items():
            tool = self.bin / name
            tool.write_text(f"#!{sys.executable}\n" + code)
            tool.chmod(0o755)

    def run_bootstrap(self):
        block = workflow.read_text().split("      - name: Install pinned devlog\n", 1)[1].split("      - name:", 1)[0]
        script = textwrap.dedent(block.split("        run: |\n", 1)[1])
        return subprocess.run(["bash", "-c", script], env=self.env, text=True, capture_output=True)

    def assert_verified_fallback(self):
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "calls").read_text().splitlines(), ["curl", "tar"])
        installed = Path((self.root / "github-path").read_text().strip()) / "devlog"
        self.assertEqual(installed.read_bytes(), self.binary)

    def test_absent_binary_downloads_and_verifies_pinned_archive(self):
        self.assert_verified_fallback()

    def test_exact_warm_binary_skips_the_archive_download(self):
        tool = self.bin / "devlog"
        tool.write_bytes(self.binary)
        tool.chmod(0o755)
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "calls").read_text(), "", "verified warm binary must not cold-download")

    def test_mismatched_binary_is_not_executed_and_uses_verified_fallback(self):
        tool = self.bin / "devlog"
        tool.write_text('#!/bin/bash\ntouch "$RUNNER_TEMP/unverified-executed"\n')
        tool.chmod(0o755)
        self.assert_verified_fallback()
        self.assertFalse((self.root / "unverified-executed").exists())

    def test_fallback_rejects_archive_checksum_mismatch(self):
        self.env["DEVLOG_ARCHIVE_SHA256"] = "0" * 64
        result = self.run_bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "calls").read_text().splitlines(), ["curl"])
        self.assertEqual((self.root / "github-path").read_text(), "")


if __name__ == "__main__":
    unittest.main()
