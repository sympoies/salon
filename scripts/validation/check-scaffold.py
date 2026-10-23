#!/usr/bin/env python3
"""Check local Markdown file links and the project validation contract."""

import re
import subprocess
import tomllib
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path(__file__).resolve().parents[2]
errors = []
tracked = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd=root,
).decode().split("\0")

for name in sorted(set(tracked) - {""}):
    if not name.endswith(".md"):
        continue
    source = root / name
    if not source.is_file():
        continue
    # The scaffold uses inline links; ignore code blocks and inline code.
    prose = re.sub(r"```.*?```", "", source.read_text(), flags=re.DOTALL)
    prose = re.sub(r"`[^`\n]*`", "", prose)
    for target in re.findall(r"\[[^\]]*\]\(([^\s)]+)\)", prose):
        url = urlsplit(target.strip("<>"))
        if url.scheme or url.netloc or not url.path:
            continue
        destination = source.parent / unquote(url.path)
        if not destination.exists():
            errors.append(f"{name}: missing local link target {target}")

with (root / "VALIDATION.toml").open("rb") as contract_file:
    contract = tomllib.load(contract_file)
validations = contract.get("validation", [])
project = [entry for entry in validations if entry.get("context") == "project-dev"]
if len(project) != 1:
    errors.append("VALIDATION.toml: expected one project-dev validation entry")
else:
    entry = project[0]
    if entry.get("commands") != ["bash scripts/validate-project-dev.sh"]:
        errors.append("VALIDATION.toml: project-dev must run the declared project gate")
    if entry.get("marker") != ".cache/agent-validation/project-dev.ok":
        errors.append("VALIDATION.toml: unexpected project-dev marker")

if errors:
    raise SystemExit("\n".join(errors))
print("Markdown file links and validation contract passed.")
