#!/usr/bin/env python3
"""Select affected PR suites; reuse only an identical, fully validated main tree."""

import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen


UI_SHARD_COUNTS = {"ui-browser": 4, "ui-unit": 3}


def select_scope(paths):
    packages = set()
    for path in paths:
        if (path.startswith("docs/") and path.endswith(".md")) or path in {
            "README.md", "DEVELOPMENT.md", "AGENTS.md"
        }:
            continue
        if path.startswith("packages/edge/"):
            packages.add("edge")
        elif path.startswith("packages/ui/"):
            packages.add("ui")
        else:
            return "full"
    return next(iter(packages)) if len(packages) == 1 else "full" if packages else "docs"


def selected_suites(scope):
    return {
        "docs": [],
        "edge": ["core", "edge"],
        "ui": ["core", "ui-unit", "ui-browser"],
        "full": ["core", "edge", "ui-unit", "ui-browser"],
    }[scope]


def job_matrix(scope):
    return [{"suite": suite, "shard": f"{i}/{count}" if count > 1 else ""}
            for suite in selected_suites(scope)
            for count in [UI_SHARD_COUNTS.get(suite, 1)]
            for i in range(1, count + 1)]


def job_name(job):
    return f"Validate {job['suite']}" + (f" ({job['shard']})" if job["shard"] else "")


def changed_scope(base, head="HEAD"):
    # --no-renames includes both sides of cross-package moves and deletions.
    merge_base = subprocess.check_output(["git", "merge-base", base, head], text=True).strip()
    paths = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", merge_base, head]
    ).decode().split("\0")
    return select_scope(filter(None, paths))


def reusable_run(run, jobs, tree, repository):
    return (
        run.get("event") == "pull_request" and run.get("conclusion") == "success"
        and (run.get("head_repository") or {}).get("full_name") == repository
        and (run.get("head_commit") or {}).get("tree_id") == tree
        and all(any(job.get("name") == job_name(expected) and job.get("conclusion") == "success"
                    for job in jobs) for expected in job_matrix("full"))
        and any(job.get("name") == "Core package validation" and job.get("conclusion") == "success"
                and any(step.get("name") == f"Full suite passed: {tree}"
                        and step.get("conclusion") == "success" for step in job.get("steps", []))
                for job in jobs)
    )


def duplicate_run(tree):
    repository = os.environ["GITHUB_REPOSITORY"]

    def api(path):
        request = Request(f"{os.environ['GITHUB_API_URL']}/repos/{repository}/{path}", headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        with urlopen(request, timeout=15) as response:
            return json.load(response)

    try:
        runs = api("actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=100")
        for run in runs["workflow_runs"]:
            if (run.get("head_commit") or {}).get("tree_id") != tree:
                continue
            jobs = api(f"actions/runs/{run['id']}/jobs?filter=latest&per_page=100")["jobs"]
            if reusable_run(run, jobs, tree, repository):
                return str(run["id"])
    except (OSError, ValueError, KeyError, TypeError):
        # API unavailability or incomplete provenance never bypasses validation.
        print("Full-run reuse unavailable; running the full suite.")
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", help="Scope a PR against its merge base; default is full")
    parser.add_argument("--github", action="store_true", help="Plan the current CI event")
    args = parser.parse_args()
    scope = changed_scope(args.base) if args.base else "full"
    if not args.github:
        print(scope)
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip()
    reused = ""
    if os.environ["GITHUB_EVENT_NAME"] == "pull_request":
        scope = changed_scope(event["pull_request"]["base"]["sha"], event["pull_request"]["head"]["sha"])
    elif os.environ["GITHUB_EVENT_NAME"] == "push":
        reused = duplicate_run(tree)
    else:
        raise SystemExit("Unsupported CI event")
    outputs = {"scope": scope, "tree": tree, "reused_run": reused,
               "suites": json.dumps([] if reused else selected_suites(scope), separators=(",", ":")),
               "matrix": json.dumps([] if reused else job_matrix(scope), separators=(",", ":"))}
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, value in outputs.items():
            print(f"{key}={value}", file=output)
    print(json.dumps(outputs))


if __name__ == "__main__":
    main()
