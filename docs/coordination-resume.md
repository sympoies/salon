# Coordination resume relay

The edge core relays authenticated resume checks and creates for a managed caller. This
contract requires matching origin and target daemon support; package fixtures do not
establish deployed Console or real-provider acceptance.

## Read-only check

The origin sends `POST /api/coordination/resume-preflight/v1` with its configured relay
bearer and this body:

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

`machine` defaults to the authenticated relay machine. The session may also include `cwd`,
`agent_profile` and `agent_args`; the target owns provider and profile admission.

Other check fields are rejected, including prompts, owner selection and operation
identifiers.

The edge verifies the caller's exact existing ownership grant, the owner's machine access
and provider-history access. Existing provider ownership must match; unclaimed provider
history requires the existing `provider_import` permission.

The check never claims a grant or advances an incarnation.

Only `session` is sent to target `POST /resume-preflight/v1`, using the target's
configured daemon credential.

Success is HTTP 200 with schema `cli.agent-session.resume-preflight.v1`, `ok: true`, and
data containing `agent`, `provider_session_id`, `machine` and a nonempty `account`. These
values must match the request and selected target.

An optional additive `history_scope` (`account` or `shared`) is accepted and preserved
under the same v1 schema. Filesystem paths, history content and arbitrary upstream fields
are not returned.

Errors use the same schema with `ok: false`. Target admission codes are retained with
`error.details.session_created: false` and `safe_to_retry: false`, including
account-transition recovery refusal.

Unsupported, malformed or missing target capability is `resume-unsupported`; unavailable
transport is `resume-preflight-unavailable`. Authentication and ownership failures keep
their own codes.

No check creates an operation, session, prompt or receipt.

## Owned creation

The existing `POST /api/coordination/sessions/v1` request carries `session.resume` through
ordinary owned creation. The edge assigns a new managed session ID and sends resumed
creates only to target `POST /sessions/resume/v1`. It preserves account, workspace,
authenticated origin, lineage, role, work references, title mode, prompt and ordinary
provider arguments. The successful response must confirm the requested provider
conversation before ownership is claimed.

### Preserve explicit account consent

A resumed create may include the optional boolean `session.resume_account_explicit`. The
origin derives it from the original account request before inserting the
preflight-resolved account pin.

The relay preserves `true` and `false` unchanged; it never infers consent from
`claude_account`. The target checks the account pin separately and uses this flag to
distinguish deliberate cancellation consent from a resolved execution account when an
account transition appears later.

Omission stays omitted for compatible clients. Non-booleans (including `null`) and a
present flag without `session.resume` are rejected before target I/O. This create-only
field is excluded from the read-only preflight contract.

### Retain creation safeguards

Existing provider ownership rules and provider mutation serialization apply. Terminal
pre-create refusal codes and their no-create/no-retry details survive this hop. Missing or
unsupported endpoints refuse without falling back to legacy `/sessions` or provider-import
creation.

## Start a prepared move

The edge relays a prepared cross-host move under the frozen [start contract][move-start]
and its [transport supplement][move-transport]. The routes exist only when the operator
sets `AGENT_CONSOLE_RESUME_MOVE=1`; without it they return 404. The destination machine
also needs its own `AGENT_CONSOLE_COORDINATION_RELAYS` entry, whose ingress token the
relay sends to it. The relay pins each move receipt to that configured machine name; the
destination itself enforces its signer identity.

- `GET /api/coordination/resume-move/v1` is the origin capability handshake. It takes no
  query, body, relay-token header or binding header, and answers with the authenticated
  origin machine and the capability `resume-move-start/v1`.
- `POST /api/coordination/resume-move/v1` starts the move using the v1.1 request shape and
  the same `agent-session.console-resume-move.v1` schema version. The `caller` object
  contains exactly `session_id` and `session_incarnation`. The relay refuses
  `caller.owner` with `resume-move-binding-mismatch` before contacting the destination.

For each operation the relay asks the pinned destination's `GET /sessions` for the
`resume_move_start_v1` capability and matching machine name. It never reuses a positive
answer, follows a redirect or falls back to another route. The status read and the start
POST then send the machine bearer, the ingress token and a relay-built binding header whose
scope is `read` or `start`. The relay derives the owner in that header from the exact caller grant.

The relay's SHA-256 receipt digest covers `machine`, `caller.session_id`,
`caller.session_incarnation` and the five `session` members `move_id`, `agent`, `resume`,
`account` and `cwd`. The relay correlates `operation_id` separately from the digest.

Before the first start the relay reads the move status. Only a staged move with a fresh
proof is forwarded, once, under the durable dispatch fence. Other observations refuse
without reserving the move: an expired proof, a prepared move or a missing proof, an
unverified proof, an admitted writer, an existing session and an aborted move each map to the
frozen refusal code. After a start may have been dispatched, only a durable `created` or
`aborted_no_writer` status resolves the outcome. Anything else stays unknown and the start
is never forwarded again.

## Recover a stale mailbox ownership binding

An authenticated running-session snapshot may include `provider_continuity` with
schema `agent-session.provider-continuity.v1`, a provider, and up to 16 ordered
links. Each link records `kind` (`clear`, `restart`, or `resume`), `from_incarnation`,
`to_incarnation`, `from_conversation`, `to_conversation`, and `at_epoch`. Clear
changes the conversation; restart and resume retain it. Adjacent endpoints must
match, times are Unix seconds from 0 through 2^53 - 1 and cannot decrease, and
identifiers must be nonblank, control-free strings of at most 256 UTF-8 bytes.

Once an incarnation or conversation is replaced, it cannot return later in the
chain, and a link must change at least one of these values.
The last endpoint must match the current
incarnation and any reported provider conversation. Only daemon-performed
lifecycle operations on the same managed session supply this evidence.

When a valid chain connects the existing grant's incarnation and conversation
to the current snapshot, the relay atomically advances both values for the same
owner and selectors. Missing, malformed, inconsistent, or stale evidence is
ignored and the existing refusal and recovery procedure still apply.

Peer discovery (`GET /api/coordination/peers/v1`) returns authorized current identities in
`peers` and a separate `excluded` array. A running recipient whose incarnation changed and
whose provider conversation differs from its durable ownership binding appears as:

```json
{
  "machine": "target",
  "session_id": "recipient-session",
  "reason": "ownership-binding-stale"
}
```

This record is an exclusion, not permission to send. Discovery includes it only when the
existing owner's machine access and the sender's messaging policy allow visibility.
It contains no provider conversation, incarnation, credential or session content.
Other ownership exclusions remain omitted; an empty `excluded` array means none of these
stale bindings were visible. Message delivery still refuses an unproven incarnation.

### Re-bind through the existing owner maintenance command

A maintainer authorized to manage the edge's ownership database can use the existing scoped
`import-owner --claim-session` command to re-associate a session with its current conversation.
Run from the repository root using the deployment's private edge configuration, including
`AGENT_CONSOLE_MACHINES`, `AGENT_CONSOLE_PRINCIPALS` and `AGENT_CONSOLE_STATE_DB`.
Keep configuration and identity values out of public logs.

1. Confirm the existing owner in the edge store and the recipient's current running
   incarnation in the authenticated daemon inventory. Set `OWNER`, `MACHINE`, `SESSION_ID`
   and `CURRENT_INCARNATION` to those verified values.
2. Check the exact session without committing any ownership changes:

   ```bash
   node --conditions=source packages/edge/scripts/import-owner.ts \
     --principal "$OWNER" --machine "$MACHINE" \
     --claim-session "$SESSION_ID" --expected-incarnation "$CURRENT_INCARNATION" --check
   ```

3. After a successful check, apply the same scoped command without `--check`:

   ```bash
   node --conditions=source packages/edge/scripts/import-owner.ts \
     --principal "$OWNER" --machine "$MACHINE" \
     --claim-session "$SESSION_ID" --expected-incarnation "$CURRENT_INCARNATION"
   ```

4. Repeat authenticated peer discovery. The recipient should appear in `peers` and no
   longer appear in `excluded`; delivery still requires its current incarnation.

The command verifies machine access, a running session and the exact current incarnation.
It refuses a session or provider conversation owned by another principal. The transaction
updates only the selected session and its provider ownership, preserving its existing
dispatcher, launcher, role and tree metadata. Check mode rolls the transaction back.
If the runtime changes or ownership conflicts, stop and inspect the new state before retrying.

The narrower `--repair-session` command requires the same provider conversation (or an
unbound session); it cannot repair the changed conversation produced by clear then restart.
This procedure adds no relay endpoint or automatic re-bind.

[move-start]: https://github.com/sympoies/nils-cli/blob/77a6e22bd3a524716f24d81b243f95b0f8bf11f0/crates/agent-session/docs/specs/console-resume-move-v1.md
[move-transport]: https://github.com/sympoies/nils-cli/blob/77a6e22bd3a524716f24d81b243f95b0f8bf11f0/crates/agent-session/docs/specs/console-resume-move-transport-v1.md

## Attested Console roots

Attested creation is off by default. Enable `AGENT_CONSOLE_ATTESTED_CREATE=1` only after
all target daemons support attested admission. Configure
`AGENT_CONSOLE_ATTESTED_CREATE_GRANTS` as a JSON array of objects containing `machine`,
`session_id`, and `role` (which must be `steward`). Each grant names an origin relay and
caller session; every request also checks the caller's live incarnation. Removing a grant
revokes it on the next request.

Configure `AGENT_CONSOLE_ATTESTED_CREATE_CREDENTIALS` as a JSON object mapping each
destination machine to its dedicated credential. Each destination needs a distinct
credential, separate from machine, relay, ingress, and browser credentials. Configure the
matching `AGENT_SESSION_CONSOLE_ATTESTED_CREATE_TOKEN` on the destination daemon and
restart that daemon after rotation. Protect both hops with HTTPS; loopback HTTP is supported
for local fixtures.

The authenticated capability endpoint is `GET /api/coordination/attested-create/v1`.
The relay sends an attested create once, verifies its returned identity and context before
claiming ownership, and retains a durable destination-and-ID fence. An uncertain outcome
requires inspection; retrying does not start another session. The relay never falls back to
ordinary creation.
