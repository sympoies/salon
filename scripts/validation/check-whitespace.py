"""Check the whole proposed change as well as local staged/unstaged changes."""

import json
import os
import re
import subprocess
from pathlib import Path


event_path = os.environ.get("GITHUB_EVENT_PATH")
if event_path:
    event = json.loads(Path(event_path).read_text())
    base = event["pull_request"]["base"]["sha"] if "pull_request" in event else event["before"]
    if not re.fullmatch(r"[0-9a-f]{40}", base) or base == "0" * 40:
        raise SystemExit("Expected the existing main/PR base commit in the CI event")
else:
    base = subprocess.check_output(["git", "merge-base", "HEAD", "origin/main"], text=True).strip()

for arguments in [["git", "diff", "--check", base, "HEAD"], ["git", "diff", "HEAD", "--check"]]:
    result = subprocess.run(arguments, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)
print("Committed change and working-tree whitespace passed.")
