"""Protect the required-check contract, including skipped and cancelled jobs."""

import unittest
import ci_scope
from ci_result import successful
from ci_scope import selected_suites


class ResultTest(unittest.TestCase):
    def test_all_selected_suites_must_pass(self):
        for scope in ["full", "edge", "ui"]:
            selected = selected_suites(scope)
            self.assertTrue(successful("success", "success", scope, selected, "", ci_scope.job_matrix(scope)))
            for result in ["failure", "cancelled", "skipped", ""]:
                with self.subTest(scope=scope, result=result):
                    self.assertFalse(successful("success", result, scope, selected, "", ci_scope.job_matrix(scope)))
            self.assertFalse(successful("success", "success", scope, selected[:-1], "", ci_scope.job_matrix(scope)))
        for result in ["failure", "cancelled", "skipped", ""]:
            self.assertFalse(successful(result, "success", "full", selected_suites("full"), "", ci_scope.job_matrix("full")))

    def test_missing_shard_matrix_cannot_pass_even_with_successful_aggregate(self):
        matrix = [{"suite": "core", "shard": ""}, {"suite": "edge", "shard": ""}]
        matrix += [{"suite": "ui-unit", "shard": f"{i}/3"} for i in range(1, 4)]
        matrix += [{"suite": "ui-browser", "shard": f"{i}/4"} for i in range(1, 5)]
        selected = selected_suites("full")
        self.assertTrue(successful("success", "success", "full", selected, "", matrix))
        for index in range(len(matrix)):
            self.assertFalse(successful("success", "success", "full", selected, "",
                                        matrix[:index] + matrix[index + 1:]))
        for result in ["failure", "cancelled"]:
            # GitHub aggregates any failed/cancelled matrix child into this result.
            self.assertFalse(successful("success", result, "full", selected, "", matrix))

    def test_only_docs_and_verified_reuse_allow_skipped_suites(self):
        self.assertTrue(successful("success", "skipped", "docs", [], "", []))
        self.assertTrue(successful("success", "skipped", "full", [], "123", []))
        self.assertFalse(successful("failure", "skipped", "full", [], "123", []))
        self.assertFalse(successful("success", "failure", "docs", [], "", []))
        self.assertFalse(successful("success", "skipped", "full", [], "", []))
        self.assertFalse(successful("success", "success", "docs", ["edge"], "", []))
        self.assertFalse(successful("success", "skipped", "", [], "", []))


if __name__ == "__main__":
    unittest.main()
