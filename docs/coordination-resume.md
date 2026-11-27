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
claiming ownership, and retains a durable destination-and-ID fence. Definitive typed 4xx
refusals, and a 415 reported as `console-create-attestation-unavailable`, are recorded and
replayed on an exact retry. A 5xx, a 408, 425 or 429, a transport failure, a timeout or a
malformed reply stays unconfirmed.

An exact retry then reads the pinned destination once the first request has
settled, without sending another create. It claims ownership only for a record with the exact ID,
role and attested context, and only when the fence row belongs to that operation. The relay never falls back
to ordinary creation.

If a 408, 425 or 429 arrives before the destination creates a record,
the exact retry reads and returns unavailable; a new operation for the same managed ID
returns 409. The operation remains unconfirmed. Making this case retryable requires
destination-side idempotency, with operation-ID proof in a later contract revision.

Reconciliation depends on one relay per destination credential, a durable fence store, and a
destination that reserves the attested initiator. A compromised credential, a second relay or
a lost fence store is outside this proof; operator repair is required.

A fence store created more than 60 seconds after the operation was minted refuses both to
reconcile and to dispatch again. Within that 60-second skew window, a replacement store
can dispatch again because the operation ID timestamp is the only clock. A conforming
destination rejects the duplicate managed ID.

Removing a grant takes effect after the relay restarts. The grant and credential environment
variables are validated at startup even when the capability is off.

## Console succession stop

Succession stop relays a fenced stop of a successor's predecessor under one Console owner.
It follows the frozen [console succession stop contract][succession-stop]. The feature is off
by default. Enable `AGENT_CONSOLE_SUCCESSION_STOP=1` only after every destination daemon
supports the contract.

Set `AGENT_CONSOLE_SUCCESSION_STOP_ISSUER_TOKEN` to a dedicated bearer of at least 32 bytes. It
must differ from every machine, relay, ingress, browser and attested-create credential. It
authorizes only the two grant routes, and every other caller is refused before the request is
parsed.

Set `AGENT_CONSOLE_SUCCESSION_STOP_DESTINATIONS` to a JSON array of configured machine names. It defaults to empty.
Listing a machine is an operator assertion that it runs a v1 succession stop destination runtime. The relay does
not probe it. An unlisted machine is only read and never receives a repeat copy. Startup fails for an unknown or
duplicate name.

The coordinating service registers a grant with
`POST /api/coordination/succession-stop-delegations/v1` and withdraws it with
`DELETE /api/coordination/succession-stop-delegations/v1/{delegation_id}`. Both use the
contract's media type. The relay derives the owner from its ownership grants, records the
grant durably and keeps it after revocation. `delegation_id` is the issue idempotency key,
and one active grant may exist for a predecessor tuple.

A managed successor stops its predecessor through its source daemon at
`POST /api/coordination/sessions/{machine}/{id}/stop/v1` and reads the receipt at
`GET /api/coordination/sessions/{machine}/{id}/stop/v1/{operation_id}`. Each request is
checked against the exact caller and predecessor tuples, one shared owner and the one active
grant bound to that operation. The relay checks again before it returns a result.

The relay claims the operation durably before it contacts the destination, using the
operation store beside the outbox. A claim is refused while input could still reach the
predecessor. A verified terminal receipt becomes an admission block for that incarnation and
is kept indefinitely. A relay refusal before the claim leaves no operation entry.

The relay
forwards the exact body bytes once with the destination bearer, its ingress token and a
binding, and never follows a redirect. Only an exact, typed reply bound to the operation is
trusted, and any other reply leaves the operation unresolved.

An exact retry before the deadline first reads the destination receipt. A recorded operation
settles from that receipt and no second stop is sent. Only a verified absence of that exact ID,
at a destination the operator has listed, permits one more copy of the request under the same
fence, because the destination deduplicates on the operation ID. A failed or malformed read, a
retry after the deadline and the internal reconcile never send a stop.

At startup and every minute the relay also reads every unresolved operation with the internal
`reconcile` scope, even after revocation. A receipt learned after revocation is stored, but never shown
to the successor. Absence never settles an operation, and pending or unknown operations stay unresolved
past the deadline. The deadline is 24 hours after issuance by the relay clock.

[succession-stop]: https://github.com/sympoies/nils-cli/blob/f723809fe5df744caba335a060c113ceb6c88cbd/crates/agent-session/docs/specs/console-succession-stop-v1.md
