"""Exercise the project validation gate's platform and marker contract."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ProjectDevPlatformTest(unittest.TestCase):
    def test_platform_label_and_full_marker(self):
        for platform, failure in (("Darwin", False), ("Linux", False), ("Darwin", True), ("Linux", True)):
            with self.subTest(platform=platform, failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root / "scripts"
                scripts.mkdir()
                (root / ".agents/scripts").mkdir(parents=True)
                shutil.copyfile(Path(__file__).resolve().parents[1] / "validate-project-dev.sh",
                                scripts / "validate-project-dev.sh")
                for name in ("install-docs-lint.sh", "docs-lint.sh", "validate-core-packages.sh"):
                    (scripts / name).write_text("#!/bin/sh\nexit 0\n")
                bin_dir = root / "bin"
                bin_dir.mkdir()
                for name in ("python3", "shellcheck", "devlog", "node", "pnpm"):
                    tool = bin_dir / name
                    tool.write_text("#!/bin/sh\nexit 0\n")
                    tool.chmod(0o755)
                if failure:
                    (scripts / "docs-lint.sh").write_text("#!/bin/sh\nexit 7\n")
                uname = bin_dir / "uname"
                uname.write_text(f"#!/bin/sh\nprintf '%s\\n' {platform}\n")
                uname.chmod(0o755)
                result = subprocess.run(["bash", str(scripts / "validate-project-dev.sh")],
                                        env=dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}"),
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 7 if failure else 0, result.stderr)
                marker = root / ".cache/agent-validation/project-dev.ok"
                self.assertEqual(marker.exists(), platform == "Linux" and not failure)
                self.assertEqual("macOS partial validation" in result.stdout, platform == "Darwin")


if __name__ == "__main__":
    unittest.main()
