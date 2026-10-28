#!/usr/bin/env python3
"""Fail the stable required check when any selected validation did not pass."""

import json
import os
from ci_scope import selected_suites


def successful(plan, suites, scope, selected, reused):
    if plan != "success" or scope not in {"docs", "edge", "ui", "full"}:
        return False
    expected = [] if reused else selected_suites(scope)
    return selected == expected and suites == ("success" if expected else "skipped")


def main():
    plan = os.environ["PLAN_RESULT"]
    suites = os.environ["SUITES_RESULT"]
    scope = os.environ["VALIDATION_SCOPE"]
    selected = json.loads(os.environ["SELECTED_SUITES"])
    reused = os.environ["REUSED_RUN"]
    if not successful(plan, suites, scope, selected, reused):
        raise SystemExit("Required validation failed, was cancelled, or is missing selected suites.")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        print(f"Scope: {scope}\nSuites: {selected}\nReused full run: {reused or 'none'}", file=summary)


if __name__ == "__main__":
    main()
