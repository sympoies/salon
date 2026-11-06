# Salon contributor instructions

Read [DEVELOPMENT.md](DEVELOPMENT.md) before editing. It owns contributor setup,
validation commands and delivery boundaries. [README.md](README.md) describes
project status and intended user behavior.

Write human-readable docs using the [shared policy](https://github.com/sympoies/agent-runtime-kit/blob/1a72ec42076f78bd79976c176911ac0fb2f3bbc1/core/policies/human-docs.md).

Keep changes focused on the requested milestone. Use English and generic,
reusable examples in all repository content. Keep credentials, personal details,
private environment information and provider payloads out of files and history.

This repository is prepared for public visibility. Issues, pull requests,
comments, review bodies, commits and release notes follow the same rule: no real
names, session or agent identifiers, host, network or machine names, personal
paths, accounts, request identifiers, chat references, or screenshots of
private environments. A private issue or pull request may be referenced only as
a bare link, without restating its content. Describe work by generic behavior
and acceptance criteria.

Run the project gate before handing off a change:

```bash
bash .agents/scripts/pre-pr.sh
```
