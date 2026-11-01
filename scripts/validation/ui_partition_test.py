"""Exercise the real UI partition runner with a recording Node transport."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
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

    def test_test_concurrency_is_configurable_and_defaults_to_three(self):
        with tempfile.TemporaryDirectory(prefix="salon-ui-concurrency-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "test-ui.sh", root / "scripts/test-ui.sh")
            test_dir = root / "packages/ui/test"
            test_dir.mkdir(parents=True)
            for name in ["domAssertSafety.test.ts", "worker.test.ts"]:
                (test_dir / name).touch()
            (root / "bin").mkdir()
            node = root / "bin/node"
            node.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CALLS"], "a") as output:
    print(json.dumps(sys.argv[1:]), file=output)
''')
            node.chmod(0o755)
            env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}", CALLS=str(root / "calls"))
            env.pop("UI_TEST_CONCURRENCY", None)

            def concurrency(**extra):
                (root / "calls").write_text("")
                result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), "unit"],
                                        env=env | extra, capture_output=True, text=True, timeout=60)
                if result.returncode:
                    return result
                calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                return [arg for arg in calls[1] if arg.startswith("--test-concurrency=")]

            self.assertEqual(concurrency(), ["--test-concurrency=3"])
            self.assertEqual(concurrency(UI_TEST_CONCURRENCY="1"), ["--test-concurrency=1"])
            for bad in ["0", "-1", "two", "1.5", ""]:
                if bad == "":
                    self.assertEqual(concurrency(UI_TEST_CONCURRENCY=bad), ["--test-concurrency=3"])
                    continue
                result = concurrency(UI_TEST_CONCURRENCY=bad)
                self.assertEqual(result.returncode, 2)
                self.assertIn("Invalid UI_TEST_CONCURRENCY", result.stderr)

    def test_package_test_entrypoint_validates_the_concurrency_value(self):
        package = json.loads((Path(__file__).resolve().parents[2] / "packages/ui/package.json").read_text())
        with tempfile.TemporaryDirectory(prefix="salon-ui-package-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "test-ui.sh", root / "scripts/test-ui.sh")
            ui = root / "packages/ui"
            (ui / "test").mkdir(parents=True)
            (ui / "test/domAssertSafety.test.ts").touch()
            (ui / "test/worker.test.ts").touch()
            (ui / "test/layout.browser.test.ts").touch()
            (root / "bin").mkdir()
            node = root / "bin/node"
            node.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CALLS"], "a") as output:
    print(json.dumps(sys.argv[1:]), file=output)
''')
            node.chmod(0o755)
            env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}", CALLS=str(root / "calls"))

            def run_package_test(value):
                (root / "calls").write_text("")
                result = subprocess.run(["sh", "-c", package["scripts"]["test"]], cwd=ui, text=True, capture_output=True,
                                        env=env | {"UI_TEST_CONCURRENCY": value}, timeout=60)
                calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
                return result, calls

            result, calls = run_package_test("2")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(["--test-reporter=tap", "--test-concurrency=2"], [call[1:3] for call in calls if len(call) > 2])
            result, calls = run_package_test("1 --test-name-pattern=^$")
            self.assertEqual(result.returncode, 2)
            self.assertIn("Invalid UI_TEST_CONCURRENCY", result.stderr)
            self.assertFalse(any("--test-name-pattern=^$" in call for call in calls))

    def test_node_shards_cover_each_partition_once(self):
        with tempfile.TemporaryDirectory(prefix="salon-ui-shards-", dir="/tmp") as directory, \
                tempfile.TemporaryDirectory(prefix="salon-node-scope-", dir="/tmp") as scope_directory:
            root = Path(directory)
            # A memory-scope wrapper first on PATH re-resolves `node` by name,
            # like the host's wrapper: the self-test's own node must not re-enter it.
            scope = Path(scope_directory) / "node"
            scope.write_text('''#!/bin/bash
PATH="${PATH//${BASH_SOURCE[0]%/*}:/}"
exec node "$@"
''')
            scope.chmod(0o755)
            patched = mock.patch.dict(os.environ, {"PATH": f"{scope_directory}:{os.environ['PATH']}"})
            patched.start()
            self.addCleanup(patched.stop)
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
# Leave this directory so a wrapper that resolves `node` by name finds the real one.
here = os.path.dirname(os.path.abspath(__file__))
os.environ["PATH"] = os.pathsep.join(p for p in os.environ["PATH"].split(os.pathsep) if p != here)
os.execv({node_bin!r}, [{node_bin!r}, *args])
''')
            wrapper.chmod(0o755)

            def run(kind, shard=""):
                result = subprocess.run(["bash", str(root / "scripts/test-ui.sh"), kind],
                                        env=dict(os.environ, UI_TEST_SHARD=shard, PATH=f"{bin_dir}:{os.environ['PATH']}"),
                                        capture_output=True, text=True, timeout=120)
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
