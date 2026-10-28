"""Exercise the real UI partition runner with a recording Node transport."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PartitionTest(unittest.TestCase):
    def test_partitions_cover_each_file_and_keep_guard_first(self):
        with tempfile.TemporaryDirectory(prefix="salon-ui-partition-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "test-ui.sh", root / "scripts/test-ui.sh")
            test_dir = root / "packages/ui/test"
            test_dir.mkdir(parents=True)
            names = ["domAssertSafety.test.ts", "worker.test.ts", "layout.browser.test.ts",
                     "headerCountAvailability.test.ts", "terminalContextCommands.test.ts"]
            for name in names:
                (test_dir / name).touch()
            (root / "bin").mkdir()
            node = root / "bin/node"
            node.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CALLS"], "a") as output:
    print(json.dumps(sys.argv[1:]), file=output)
if os.environ.get("FAIL_GUARD") == "1":
    sys.exit(7)
''')
            node.chmod(0o755)
            env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}", CALLS=str(root / "calls"))
            selected = {}
            for kind in ["unit", "browser"]:
                (root / "calls").write_text("")
                result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), kind], env=env, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                self.assertEqual(calls[0], ["--test", "test/domAssertSafety.test.ts"])
                selected[kind] = set(calls[1][3:])
            self.assertFalse(selected["unit"] & selected["browser"])
            self.assertEqual(selected["unit"] | selected["browser"], {f"test/{name}" for name in names})
            self.assertEqual(selected["browser"], {f"test/{name}" for name in names[2:]})
            (root / "calls").write_text("")
            result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), "browser"],
                                    env=env | {"FAIL_GUARD": "1"}, capture_output=True)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(len((root / "calls").read_text().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
