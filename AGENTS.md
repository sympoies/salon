# Salon contributor instructions

Read [DEVELOPMENT.md](DEVELOPMENT.md) before editing. It owns contributor setup,
validation commands and delivery boundaries. [README.md](README.md) describes
project status and intended user behavior.

Keep changes focused on the requested milestone. Use English and generic,
reusable examples in all repository content. Keep credentials, personal details,
private environment information and provider payloads out of files and history.

This repository is prepared for public visibility. Issues, pull requests,
comments, review bodies, commits and release notes follow the same rule: no real
names, session or agent identifiers, host, network or machine names, personal
paths, accounts, request identifiers, chat references, screenshots of private
environments, or links to private repositories. Describe work by generic
behavior and acceptance criteria.

Run the project gate before handing off a change:

```bash
bash .agents/scripts/pre-pr.sh
```
