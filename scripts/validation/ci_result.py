#!/usr/bin/env python3
"""Fail the stable required check when any selected validation did not pass."""

import json
import os
from ci_scope import job_matrix, selected_suites


def successful(plan, suites, scope, selected, reused, matrix):
    if plan != "success" or scope not in {"docs", "edge", "ui", "full"}:
        return False
    expected = [] if reused else selected_suites(scope)
    # GitHub's needs.suites.result succeeds only when every matrix child succeeds.
    return (selected == expected and matrix == ([] if reused else job_matrix(scope))
            and suites == ("success" if expected else "skipped"))


def main():
    plan = os.environ["PLAN_RESULT"]
    suites = os.environ["SUITES_RESULT"]
    scope = os.environ["VALIDATION_SCOPE"]
    selected = json.loads(os.environ["SELECTED_SUITES"])
    reused = os.environ["REUSED_RUN"]
    matrix = json.loads(os.environ["SELECTED_MATRIX"])
    if not successful(plan, suites, scope, selected, reused, matrix):
        raise SystemExit("Required validation failed, was cancelled, or is missing selected suites or shards.")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        print(f"Scope: {scope}\nSuites: {selected}\nMatrix: {matrix}\nReused full run: {reused or 'none'}", file=summary)


if __name__ == "__main__":
    main()
