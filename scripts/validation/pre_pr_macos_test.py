"""Check the pre-PR entrypoint's macOS Bash requirement."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "darwin", "requires macOS system Bash")
class MacOSBashTest(unittest.TestCase):
    def test_system_bash_fails_before_starting_validation(self):
        script = Path(__file__).resolve().parents[2] / ".agents/scripts/pre-pr.sh"
        with tempfile.TemporaryDirectory() as directory:
            fake_bash = Path(directory) / "bash"
            fake_bash.write_text("#!/bin/sh\nexit 0\n")
            fake_bash.chmod(0o755)
            result = subprocess.run(
                ["/bin/bash", str(script)],
                env=dict(os.environ, PATH=f"{directory}:{os.environ['PATH']}"),
                capture_output=True, text=True, timeout=10,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Bash 4", result.stderr)
        self.assertIn("PATH", result.stderr)


if __name__ == "__main__":
    unittest.main()
