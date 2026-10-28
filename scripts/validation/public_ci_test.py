"""Public pull requests, including forks, must use hosted isolation."""

from pathlib import Path
import re
from types import SimpleNamespace
import unittest


workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"


class PublicCiTest(unittest.TestCase):
    def test_all_jobs_use_hosted_ubuntu_and_keep_required_aggregator(self):
        text = workflow.read_text()
        runners = re.findall(r"^    runs-on: (.+)$", text, re.MULTILINE)
        self.assertEqual(len(runners), 3)
        self.assertTrue(all(runner == "ubuntu-24.04" for runner in runners))
        self.assertIn("    name: Core package validation\n", text)
        self.assertIn("    needs: [plan, suites]\n", text)
        self.assertIn("      fail-fast: false\n", text)

    def test_fork_and_same_repository_prs_are_admitted_but_other_pushes_are_not(self):
        text = workflow.read_text()
        for name in ["plan", "validate"]:
            block = text.split(f"  {name}:\n", 1)[1].split("    runs-on:", 1)[0]
            expression = " ".join(block.split("    if: >-\n", 1)[1].split())
            expression = expression.replace("&&", " and ").replace("||", " or ")
            for event, ref, head_repo, expected in [
                ("pull_request", "refs/pull/1/merge", "example/fork", True),
                ("pull_request", "refs/pull/2/merge", "example/project", True),
                ("push", "refs/heads/main", "example/project", True),
                ("push", "refs/heads/topic", "example/project", False),
            ]:
                github = SimpleNamespace(event_name=event, ref=ref, repository="example/project",
                                         event=SimpleNamespace(pull_request=SimpleNamespace(
                                             head=SimpleNamespace(repo=SimpleNamespace(full_name=head_repo)))))
                selected = eval(expression, {"__builtins__": {}}, {"github": github, "always": lambda: True})
                with self.subTest(job=name, event=event, head_repo=head_repo):
                    self.assertEqual(selected, expected)
        permissions = text.split("permissions:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertIn("contents: read", permissions)
        self.assertIn("actions: read", permissions)
        self.assertNotIn(": write", permissions)
        self.assertNotIn("pull_request_target:", text)


if __name__ == "__main__":
    unittest.main()
