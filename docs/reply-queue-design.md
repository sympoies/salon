# Reply queue and steering design

Status: proposed design for [#433][issue]; no production behavior changes here.
Implementation work is listed below for the maintainer to file after review.

## Decision and example

Extend the existing durable edge outbox with an editable waiting queue. While a
turn is running, default to **Queue**; offer **Steer now** as an explicit
alternative when the exact runtime supports acknowledged same-turn input.
An unsupported steer becomes Queue before provider dispatch. The runtime owns
provider admission and receipts; it does not own a second editable queue.

For example, queue “Add a regression test” while an agent works. It stays on the
server and can be edited or cancelled from another client. “Use the smaller
fixture instead” can explicitly steer the running turn on a capable runtime.
Once either reply is claimed for dispatch, it cannot be edited or retracted.
An unconfirmed result never creates another send automatically.

The guarantee is **at-most-once dispatch per attempt**, including across edge
and daemon restarts. It is not guaranteed delivery, model consumption, or
exactly-once execution. A definite pre-delivery refusal permits a new attempt;
an unknown attempt does not. This distinction follows the [prompt contract][prompt].

## Current behavior and evidence

The source baseline is Salon commit `cf813ab5d0e62d4d2e8ec0e04d91b0e9193353d0`
and nils-cli commit `8783300d30d4d339495a675ad9f1b03a29da1065`.
Provider documentation was checked on 2026-11-13. These are source findings,
not live provider or device acceptance.

- [ConversationComposer](../packages/ui/src/ConversationComposer.tsx) sends new
  supported-provider replies through `SharedOutboxClient.enqueue`, including
  voice submissions. Desktop Enter submits; Shift+Enter and phone Enter retain
  newline behavior. A busy session still admits a reply.
- [SharedOutboxClient](../packages/ui/src/sharedOutboxClient.ts) journals local
  admissions in IndexedDB before network I/O, reuses their immutable IDs, and
  refreshes server revisions. Codex history can hand over an echo by accepted
  request identity and its edge intent association. It does not dispatch input.
- [OutboxStore](../packages/edge/src/outboxStore.ts) already uses durable SQLite
  transactions, item revisions, attempt records and cancellation tombstones.
  New rows opt into native handoff. Only definite refusals have Retry/Discard;
  the current `queued` label does not promise an editable idle queue.
- [SharedOutboxDispatcher](../packages/edge/src/sharedOutbox.ts) claims before
  POST, submits with `require_idle: false`, and recovers uncertain claims with
  receipt GETs. It deliberately does not wait for an idle turn.
- [ConversationOutbox](../packages/ui/src/conversationOutbox.ts) retains the
  older browser-local queue, grace period, Codex idle guard and receipt lookup.
  The composer still services retained rows. Migration must retire its dispatch
  owner, rather than copy those rows into another active sender.

## Provider support and fallback

Steering means acknowledged input to the particular running turn without
interrupting it. Acceptance does not mean the model has already read it.
A busy native handoff and a provider's own queue are different guarantees.

| Runtime | Evidence | Proposed Salon behavior |
| --- | --- | --- |
| Managed Codex app-server | Official [app-server docs][codex] define `turn/steer`, matching `expectedTurnId`, and a returned accepted turn ID. The runtime already uses this for [mailbox notices][mailbox]. | Enable after the owner-prompt adapter and request-bound receipt proof are implemented and accepted. |
| Claude terminal | [Interactive-mode docs][claude] describe queued messages entering at tool boundaries or after a turn. The [current daemon contract][prompt] acknowledges a new turn or a newly observed exact queued entry. | Queue only. Existing queue acknowledgment does not prove steering into a specific active turn. |
| Raw, imported, unsupported or unobservable runtime | No demonstrated request-bound same-turn acknowledgment in the audited owner-prompt path. | Queue if safe idle delivery is supported; otherwise retain locally and explain that sending is unavailable. |

Codex owner prompts currently use `turn/start` for [native busy replies][native],
not the strict steer operation. The mailbox implementation demonstrates a
transport building block, not an already available owner-prompt API. Do not
infer capability from the provider name, a version number alone or a text hint.
Expose capability for the exact live incarnation, control connection and turn.

Claude's terminal queue can affect the current turn, but its current receipt
cannot promise which turn consumed a particular item. This design does not
switch Claude harnesses or synthesize Ctrl+Enter, Escape or interrupt keys.
Those transports need separate evidence before they can advertise steer.

If support is absent at admission, persist the same intent as Queue and show
“Queued: steering is unavailable.” If the target turn ends or capability changes
before dispatch, do the same. If the strict runtime route returns a durable
**definite non-delivery** refusal for a lost turn or unsupported steer, retain
that attempt and convert the item to Queue in one transaction.

After any possible dispatch, timeout, malformed acknowledgment or unknown
receipt, do not fall back to Queue. Keep the exact attempt for read-only lookup.
A generic provider error is not proof of non-delivery. Real draft, authorization,
account and attention refusals remain visible refusals, not automatic fallback.

## Queue ownership, order and restart behavior

Use the configured edge state database and its persistent volume. A browser
cache is a journal of unacknowledged admissions and display metadata; it is
never the authoritative waiting queue. Edge downtime delays delivery while the
runtime may continue working. Losing the database is outside restart durability:
stop dispatch and recover it; do not reconstruct sends from browser echoes.

Retain the existing principal, machine, session, exact incarnation and credential
generation scope. Authorize every mutation and recheck before dispatch after I/O.
Queue ordering and the dispatch fence use machine/session/incarnation identity,
so separate clients or principal views cannot create concurrent queue drains.
Access to a snapshot alone never grants edit or send authority.

Each item stores an immutable admission ID and admission fingerprint, current
text, chosen action (`queue` or `steer`), effective action, stable ordering key,
item revision and target identity. Keep separate immutable dispatch attempts with
request IDs, payload fingerprints and receipts. The admission fingerprint stays
unchanged after editing, so a delayed original PUT returns the current item
instead of restoring old text. Include the original action in that fingerprint.

Queue admission has no provider attempt. An atomic revision-checked mutation
can edit text, cancel, reorder, or promote an unclaimed item to Steer. Reorder
also compares the queue revision; stale clients refresh on conflict. Cancel
retains a tombstone so delayed admission retries cannot resurrect the item.
Reuse existing capacity limits; reject overflow without clearing the local draft.

The dispatcher processes Queue items in FIFO order, skipping cancelled and
terminal items. It claims only the head eligible item, recording the exact
payload and a fresh request ID durably **before** provider I/O. Edit/cancel and
claim compete in the same transaction: the winner determines the outcome.
A claimed row becomes immutable even if the process dies before its POST.

For Queue, require a trustworthy idle observation with no attention, pending
ingress, lifecycle operation or unresolved earlier queue attempt. Submit through
`prompt/v2` with `require_idle: true`; the daemon rechecks actual provider idle
and composer state under its existing fences. Cached UI state is only a hint.
A definite `busy` receipt returns the item to waiting. Retry with a new attempt
only after another eligible observation, with bounded backoff to avoid polling
input repeatedly. Other definite refusals expose Retry/Discard.

Persist the consumed idle boundary with the claim. After submission, wait for
its new turn to start and finish before releasing the next Queue item. Do not
drain several items against the same stale idle snapshot. The runtime readiness
contract below supplies a consumable boundary; a lost start/completion or an
unhealthy activity stream pauses the queue until authoritative readiness returns.
Failed or interrupted turns can release a new idle boundary only when the
runtime independently proves readiness; attention never counts as completion.

An unknown Queue attempt pauses later automatic Queue items to preserve order.
A separate, deliberate Steer can overtake waiting items when its runtime fences
permit; it never retries or resolves that unknown. Explain this ordering choice
in the action menu. No elapsed timer turns uncertainty into permission to send.

| Durable state at restart | Recovery |
| --- | --- |
| Waiting, unclaimed | Reload FIFO, revalidate ownership and incarnation, then wait for readiness. |
| Claimed/sending, with or without a known POST | Mark uncertain and GET the original receipt; never dispatch that claim again. |
| Submitted or command-dispatched | Retain terminal evidence; never resend. |
| Definite refusal | Preserve the refusal; only the specified busy/fallback policy or explicit Retry makes a new attempt. |
| Cancelled or pruned terminal row | Retained tombstone/attempt record answers late admissions without recreating input. |

Keep attempt identities and cancellation fences beyond visible-row pruning.
Do not expire them while their admission IDs can be replayed. On target
replacement, retire waiting items and preserve attempts as history; do not
retarget them. Existing [archive/delete lifecycle fences][lifecycle] must block
new admissions and claims, and must count waiting Queue items as pending work.

## Composer on desktop and phone

When idle and no queued items exist, the main button says **Send**. During work
or with a waiting backlog, it says **Queue**. The action menu offers **Steer now**
only when currently supported; its explanation says it can overtake queued work.
If readiness is unknown, preserve the draft or admit Queue with “Waiting for
session status”; never imply steering support. Queue remains the default after
using the alternative; no new preference setting is needed.

On desktop, Enter invokes the displayed default, Shift+Enter inserts a newline,
and Ctrl+Enter (Cmd+Enter on macOS) invokes Steer while busy and supported.
The visible menu provides the same action for discovery and keyboard access.
An unavailable alternative keeps the draft and announces why; it does not send
with a different meaning. IME composition never submits. On phones, Enter stays
a newline; use the labelled primary button and adjacent action menu, with no
hover or modifier requirement. Voice submission uses the displayed default.

Show a compact **Queued (count)** list above the composer on both layouts, with
preview, position and status. Server-accepted waiting items appear across
clients, unlike device-owned local admissions and echoes. Offer Edit, Cancel,
Move earlier/later and, when supported, Steer now. Drag reordering can be added
only as a convenience; buttons cover touch and assistive technology.

Opening Edit first commits a revision-checked server hold on that item. The
held head also pauses later Queue items. Save updates the same intent and
releases the hold; Cancel editing releases it without changing text. Keep an
ordinary composer draft separate. A hold survives browser disconnection and
server restart; show **Resume queue** to release an abandoned hold explicitly.
Saving after another client releases it must conflict, preserving local edits.
Do not silently expire a hold and send text while someone is editing it.

Only acknowledge **Queued** after durable server admission. Before that, show
**Syncing** with the local draft journal retained. Claimed items show **Sending**;
confirmed handoffs show **Sent** until transcript handover. Unknown items show
**Delivery unconfirmed** with Check status and local Hide, never Retry/Edit/Cancel.
Hide removes only an echo. Announce mutations and conflicts, retain focus after
reordering, and keep actions reachable with the phone keyboard open.

## Existing reply paths and duplicate prevention

Extend the shared outbox, its normalizers, edge routes, dispatcher and renderer
as one current contract. Stop new browser-local queue admissions and dispatch
for these sessions in the same change. Keep `conversationOutbox` receipt and
transcript reconciliation for already attempted rows, without another sender.

Migrate proven unattempted browser-local rows once through a durable local
transfer record, preserving their intent IDs and target incarnation. A crash
repeats the same edge admission ID, never creates a second intent. Anything with
a dispatch claim, attempt timestamp or ambiguous provenance stays lookup-only
under its original key. Definite refused rows retain Retry/Discard; an explicit
retry transfers ownership to the shared outbox atomically with a stable ID.
Do not migrate uncertain text as an unattempted reply.

For existing shared rows, preserve attempted payloads and receipts unchanged.
Convert only proven unclaimed native-handoff rows to the new waiting policy;
keep held rows paused. Upgrade all edge writers together and invalidate stale
client bundles. No dual dispatchers, old action aliases or indefinite dual wire
forms are part of this proposal.

All pending, refused and outgoing views render the same intent. A definite
refusal permits revision-checked Retry with a new attempt; an unknown never does.
Transcript matching can hand over a local echo, but cannot authorize a new
provider dispatch or manufacture a daemon receipt. Preserve the existing
one-use transcript proof for repeated identical messages and command echoes.
Preserve Codex request/intent identity handover; Claude text matches remain
display evidence. Receipts win over HTTP status alone.

Attachments retain the current upload paths and target binding; editing can
remove or replace references before claim. Local filenames and previews remain
local metadata. No upload or queue text is copied to logs or public evidence.
Queued commands remain subject to the runtime command guard and cannot steer.
The [proposed explicit command-intent contract][intent] is a separate dependency:
keep text/command intent distinct from queue/steer delivery policy and migrate
its agreed callers together when that contract lands.

## Runtime contract deltas

These are proposed nils-cli changes, not current API claims:

1. Expose per-session reply delivery capability and an opaque active-turn steer
   target in the existing session projection. Bind it to exact runtime,
   conversation and account identity; invalidate it on replacement or lost
   control. Expose a monotonic idle-ready boundary only after trustworthy
   provider/composer admission checks. Consuming it permits one guarded queued
   attempt; the next requires renewed readiness, not a repeated stale snapshot.
2. Extend guarded `prompt/v2` submission with an expected idle-ready boundary
   for queue callers. Validate and durably consume it under the runtime claim
   fence before input; busy or stale-boundary rejection is definitely before
   dispatch. Bind it into the keyed payload fingerprint. Preserve ordinary
   `require_idle` semantics for other current callers; this is an additional
   queue fence, not a second implementation of idle detection in Salon.
3. Add a strict authenticated `POST /sessions/{id}/prompt/steer/v1` operation
   for exact text, expected incarnation, request ID and opaque steer target.
   Resolve the private active turn and use acknowledged Codex `turn/steer`.
   Reject unsupported transport, stale turn, command input and unsafe admission
   before dispatch with typed refusal receipts. Preserve all existing owner,
   account, lifecycle, quarantine and real-composer protections.
4. Reuse the existing receipt GET and durable claim namespace for both prompt
   operations. Fingerprint operation kind and exact target along with payload;
   changing kind or turn under the same request ID conflicts. Record confirmed
   delivery kind in receipts. Steering success requires the matching accepted
   active turn; it must not claim a new turn or merely observe an unrelated hook.
5. Retain request-bound steer proof across restart when the provider supplies
   it. Missing or ambiguous acceptance stays unknown, with lookup only. Extend
   current reconciliation without weakening its identity fences or interpreting
   a queue sighting as same-turn proof. Freeze the exact provider-version support
   only after schema checks and a disposable live acceptance probe.

Update runtime prompt/observation specs, edge forwarding, shared receipt types,
all affected request constructors and fixtures together. This adds an explicit
operation; it does not rename `require_idle` or keep a retired contract alive.
Old claimed attempts remain evidence, never rewritten as steer or queue attempts.
The runtime stores no editable idle queue and exposes no raw provider turn IDs.

## Rejected options

| Option | Reason |
| --- | --- |
| Editable queue inside each runtime daemon | Duplicates the existing edge store and spreads multi-client edits, auth and retention across machines. Keep admission near the existing shared UI API. |
| Browser-only queue | Delivery stops when the browser closes; clients disagree on order and cancellation. |
| Provider-native queue as the editable server queue | Handoff already crossed the cancellation boundary; neither current adapter provides safe remote edit/reorder/cancel. |
| Treat `require_idle: false` as Steer | Current native handoff does not guarantee a specific running turn. |
| Default to Steer | Unintentional redirection is costly; Queue preserves an explicit opportunity to review or cancel. |
| Retry or enqueue after an uncertain steer | The first attempt may have arrived; a new send can duplicate it. |
| Replace the Claude harness in this spike | A separate transport project is unnecessary for a useful durable queue. |

## Ordered implementation issues to file

The maintainer files these after accepting the design; none are created by this
spike. Runtime items belong in nils-cli, consumer items in Salon.

1. **Runtime: queued-input readiness fence.** Specify and implement the
   incarnation-bound capability, idle-ready boundary, claim consumption and
   receipt fingerprint change. Prove stale snapshots and concurrent consumers
   cannot submit two Queue items into one idle boundary.
2. **Runtime: strict keyed owner steering.** Implement the Codex steer route,
   typed non-delivery refusals and request-bound receipt/reconciliation. Verify
   lost acknowledgments, restart, changed turn/account and duplicate keys.
   Claude remains Queue-only until a separate adapter proves strict steering.
3. **Salon: durable editable queue and single dispatcher.** Add action/order/
   hold mutations with revision checks, preserve tombstones and attempt history,
   implement guarded FIFO and fallback, and migrate existing local/shared rows
   without a second sender. Depend on item 1; enabling steer depends on item 2.
4. **Salon: composer choice and queue controls.** Implement the phone/desktop
   actions, cross-client waiting list, editing hold and accessible ordering.
   Update pending/refused/unknown views together. Depend on item 3.
5. **Integration: restart and provider acceptance.** Exercise a counting daemon
   through the real edge API for admission replay, edit/cancel/claim races,
   crash-before-POST, lost response, late receipt, busy retry, stale idle boundary,
   multi-client order and obsolete incarnation. Then schedule disposable live
   Codex steering, Claude idle delivery and phone/desktop acceptance through the
   normal test owner. Confirm input arrival as well as at-most-one provider send.

Documentation checks validate this note's structure and links. They do not
prove the proposed protocol, runtime readiness or provider acceptance.

[issue]: https://github.com/sympoies/salon/issues/433
[prompt]: https://github.com/sympoies/nils-cli/blob/8783300d30d4d339495a675ad9f1b03a29da1065/crates/agent-session/docs/specs/serve-prompt-v1.md
[native]: https://github.com/sympoies/nils-cli/blob/8783300d30d4d339495a675ad9f1b03a29da1065/crates/agent-session/docs/specs/native-busy-replies.md
[mailbox]: https://github.com/sympoies/nils-cli/blob/8783300d30d4d339495a675ad9f1b03a29da1065/crates/agent-session/docs/specs/serve-mailbox-automation-v1.md
[intent]: https://github.com/sympoies/nils-cli/blob/8783300d30d4d339495a675ad9f1b03a29da1065/crates/agent-session/docs/specs/owner-prompt-intent.md
[codex]: https://learn.chatgpt.com/docs/app-server#steer-an-active-turn
[claude]: https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works
[lifecycle]: outbox-lifecycle-recovery.md
