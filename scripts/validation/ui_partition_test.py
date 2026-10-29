"""Exercise the real UI partition runner with a recording Node transport."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import re


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

    def test_node_shards_cover_each_partition_once(self):
        with tempfile.TemporaryDirectory(prefix="salon-ui-shards-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "test-ui.sh", root / "scripts/test-ui.sh")
            test_dir = root / "packages/ui/test"
            test_dir.mkdir(parents=True)
            names = ["domAssertSafety.test.ts", "worker.test.ts", "other.test.ts",
                     "layout.browser.test.ts", "headerCountAvailability.test.ts",
                     "terminalContextCommands.test.ts", "panel.browser.test.ts"]
            for name in names:
                (test_dir / name).write_text(f'import {{ test }} from "node:test"; test("{name}", () => {{}});\n')

            # Normalize the preflight reporter across local and hosted Node defaults.
            node_bin = shutil.which("node")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            wrapper = bin_dir / "node"
            wrapper.write_text(f'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if not any(arg.startswith("--test-reporter=") for arg in args):
    args.insert(0, "--test-reporter=tap")
os.execv({node_bin!r}, [{node_bin!r}, *args])
''')
            wrapper.chmod(0o755)

            def run(kind, shard=""):
                result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), kind],
                                        env=dict(os.environ, UI_TEST_SHARD=shard, PATH=f"{bin_dir}:{os.environ['PATH']}"),
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                tests = re.findall(r"^# Subtest: (.+)$", result.stdout, re.MULTILINE)
                self.assertEqual(tests.pop(0), "domAssertSafety.test.ts")
                return tests

            for kind, count in [("unit", 3), ("browser", 4)]:
                expected = run(kind)
                sharded = [name for i in range(1, count + 1) for name in run(kind, f"{i}/{count}")]
                self.assertCountEqual(sharded, expected)
                self.assertEqual(len(sharded), len(set(sharded)))
            # A nonempty partition may legitimately have empty shards.
            self.assertEqual(run("browser", "20/20"), [])
            for shard in ["0/3", "1/0", "4/3", "01/3", "1/03", "1", "-1/3", "1/3/4", "1/3\n"]:
                with self.subTest(shard=shard):
                    result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), "unit"],
                                            env=dict(os.environ, UI_TEST_SHARD=shard), capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("Invalid UI_TEST_SHARD", result.stderr)
            for path in test_dir.glob("*.test.ts"):
                if path.name != "domAssertSafety.test.ts":
                    path.unlink()
            result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), "browser"],
                                    env=dict(os.environ, UI_TEST_SHARD="1/4"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Empty UI test partition", result.stderr)


if __name__ == "__main__":
    unittest.main()
