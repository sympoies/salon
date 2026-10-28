# Coordination resume relay

The edge core relays authenticated resume checks and creates for a managed
caller. This contract requires matching origin and target daemon support;
package fixtures do not establish deployed Console or real-provider acceptance.

## Read-only check

The origin sends `POST /api/coordination/resume-preflight/v1` with its configured
relay bearer and this body:

```json
{
  "source_session_id": "caller-session",
  "source_incarnation": "caller-incarnation",
  "machine": "target",
  "session": {
    "agent": "claude",
    "resume": "a18a563c-3913-4f21-a82a-7ca859b94a04",
    "claude_account": "work"
  }
}
```

`machine` defaults to the authenticated relay machine. The session may also
include `cwd`, `agent_profile` and `agent_args`; the target owns provider and
profile admission. Other check fields are rejected, including prompts, owner
selection and operation identifiers.

The edge verifies the caller's exact existing ownership grant, the owner's
machine access and provider-history access. Existing provider ownership must
match; unclaimed provider history requires the existing `provider_import`
permission. The check never claims a grant or advances an incarnation.

Only `session` is sent to target `POST /resume-preflight/v1`, using the target's
configured daemon credential. Success is HTTP 200 with schema
`cli.agent-session.resume-preflight.v1`, `ok: true`, and data containing `agent`,
`provider_session_id`, `machine` and a nonempty `account`. These values must
match the request and selected target. An optional additive `history_scope`
(`account` or `shared`) is accepted and preserved under the same v1 schema.
Filesystem paths, history content and arbitrary upstream fields are not returned.

Errors use the same schema with `ok: false`. Target admission codes are retained
with `error.details.session_created: false` and `safe_to_retry: false`, including
account-transition recovery refusal. Unsupported, malformed or missing target
capability is `resume-unsupported`; unavailable transport is
`resume-preflight-unavailable`. Authentication and ownership failures keep their
own codes. No check creates an operation, session, prompt or receipt.

## Owned creation

The existing `POST /api/coordination/sessions/v1` request carries `session.resume`
through ordinary owned creation. The edge assigns a new managed session ID and
sends resumed creates only to target `POST /sessions/resume/v1`. It preserves
account, workspace, authenticated origin, lineage, role, work references, title
mode, prompt and ordinary provider arguments. The successful response must
confirm the requested provider conversation before ownership is claimed.

A resumed create may include the optional boolean `session.resume_account_explicit`.
The origin derives it from the original account request before inserting the
preflight-resolved account pin. The relay preserves `true` and `false` unchanged;
it never infers consent from `claude_account`. The target checks the account pin
separately and uses this flag to distinguish deliberate cancellation consent
from a resolved execution account when an account transition appears later.
Omission stays omitted for compatible clients. Non-booleans (including `null`)
and a present flag without `session.resume` are rejected before target I/O.
This create-only field is excluded from the read-only preflight contract.

Existing provider ownership rules and provider mutation serialization apply.
Terminal pre-create refusal codes and their no-create/no-retry details survive
this hop. Missing or unsupported endpoints refuse without falling back to
legacy `/sessions` or provider-import creation.
