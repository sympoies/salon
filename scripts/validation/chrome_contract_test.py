"""Chrome must be available wherever validation consumes packed UI artifacts."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


root = Path(__file__).resolve().parents[2]


class ChromeContractTest(unittest.TestCase):
    def test_workflow_provisions_both_chrome_consumers(self):
        workflow = (root / ".github/workflows/ci.yml").read_text()
        for step in ["Probe preinstalled Chrome", "Install headless Chrome runtime libraries",
                     "Select and probe headless Chrome"]:
            block = workflow.split(f"      - name: {step}\n", 1)[1].split("      - name:", 1)[0]
            condition = re.search(r"^        if: (.+)$", block, re.MULTILINE).group(1)
            for suite in ["core", "ui-browser", "edge", "ui-unit"]:
                for ready in ["", "true"]:
                    # These step predicates use the shared Python/Actions comparison
                    # grammar plus Actions boolean operators; no workflow code runs.
                    selected = eval(condition.replace("&&", " and ").replace("||", " or "),
                                    {"__builtins__": {}}, {
                                        "matrix": SimpleNamespace(suite=suite),
                                        "steps": SimpleNamespace(chrome=SimpleNamespace(
                                            outputs=SimpleNamespace(ready=ready))),
                                    })
                    expected = suite in {"core", "ui-browser"} and (
                        step == "Probe preinstalled Chrome" or ready != "true")
                    with self.subTest(step=step, suite=suite, ready=ready):
                        self.assertEqual(selected, expected)

    def test_local_preflight_rejects_missing_chrome_before_install(self):
        with tempfile.TemporaryDirectory(prefix="salon-chrome-contract-", dir="/tmp") as directory:
            fixture = Path(directory)
            (fixture / "scripts").mkdir()
            shutil.copyfile(root / "scripts/validate-core-packages.sh", fixture / "scripts/validate-core-packages.sh")
            (fixture / "bin").mkdir()
            for command, version in [("node", "24"), ("pnpm", "11.9.0")]:
                tool = fixture / "bin" / command
                tool.write_text(f'''#!/bin/bash
if [[ "$1" == --version || "$1" == -p ]]; then
  printf '%s\\n' '{version}'
else
  printf '%s\\n' '{command}' >> "$CALLS"
fi
''')
                tool.chmod(0o755)
            env = dict(os.environ, PATH=f"{fixture / 'bin'}:{os.environ['PATH']}",
                       CHROME_BIN=str(fixture / "absent-chrome"), CALLS=str(fixture / "calls"))
            for arguments in [["--suite", "core"], ["edge"]]:
                with self.subTest(arguments=arguments):
                    (fixture / "calls").write_text("")
                    result = subprocess.run(["bash", str(fixture / "scripts/validate-core-packages.sh"), *arguments],
                                            env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0, "Chrome-consuming paths must fail preflight")
                    self.assertIn("require headless Chrome", result.stderr)
                    self.assertEqual((fixture / "calls").read_text(), "", "do not install before failed preflight")
            result = subprocess.run(["bash", str(fixture / "scripts/validate-core-packages.sh"), "--suite", "edge"],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, "the standalone edge suite has no browser dependency")


if __name__ == "__main__":
    unittest.main()
