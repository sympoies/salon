"""Protect the required-check contract, including skipped and cancelled jobs."""

import unittest
from ci_result import successful
from ci_scope import selected_suites


class ResultTest(unittest.TestCase):
    def test_all_selected_suites_must_pass(self):
        for scope in ["full", "edge", "ui"]:
            selected = selected_suites(scope)
            self.assertTrue(successful("success", "success", scope, selected, ""))
            for result in ["failure", "cancelled", "skipped", ""]:
                with self.subTest(scope=scope, result=result):
                    self.assertFalse(successful("success", result, scope, selected, ""))
            self.assertFalse(successful("success", "success", scope, selected[:-1], ""))
        for result in ["failure", "cancelled", "skipped", ""]:
            self.assertFalse(successful(result, "success", "full", selected_suites("full"), ""))

    def test_only_docs_and_verified_reuse_allow_skipped_suites(self):
        self.assertTrue(successful("success", "skipped", "docs", [], ""))
        self.assertTrue(successful("success", "skipped", "full", [], "123"))
        self.assertFalse(successful("failure", "skipped", "full", [], "123"))
        self.assertFalse(successful("success", "failure", "docs", [], ""))
        self.assertFalse(successful("success", "skipped", "full", [], ""))
        self.assertFalse(successful("success", "success", "docs", ["edge"], ""))
        self.assertFalse(successful("success", "skipped", "", [], ""))


if __name__ == "__main__":
    unittest.main()
