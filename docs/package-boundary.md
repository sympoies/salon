# Core package boundary

The reusable core consists of `@agent-console/shared`, `@agent-console/edge` and
`@agent-console/ui`. Existing names remain in this private preparation phase; the current
version is in each package's `package.json` and the
[package consumption](package-consumption.md) guide, not repeated here.

This repository does not contain a downstream distribution's private composition,
configuration or native packaging.

## Import rules

- Shared contracts import no other workspace package.
- Edge and UI may import shared contracts through explicit exported subpaths.
- Core relative imports stay within their package. Edge and UI do not import
  one another or a downstream distribution.
- Consumers use explicit package exports; they do not reach into source paths.

`pnpm check:core` checks these rules and runs a strict generic privacy scan over source,
tests, assets and emitted package files.

The scan rejects credential shapes, personal home paths and non-example email addresses.
There is no baseline or private vocabulary in this repository. A zero finding result is a
bounded automated check, alongside review of the source allowlist and licenses.

## Development and package consumption

Workspace TypeScript tests select the `source` condition. Normal package resolution
selects compiled ESM JavaScript; TypeScript consumers select emitted declarations.

Node 24 cannot strip TypeScript inside `node_modules`, so source exports are insufficient
for installed consumers.

`pnpm build:packages` cleans and compiles all three packages in dependency order. Each
package includes `dist-package/` only, with declarations, the MIT license and necessary
runtime assets. UI assets preserve relative CSS and font paths; font notices remain with
the font assets. Package exports are explicit, with no wildcard exposing every internal
module.

The edge exports a start function accepting an environment and optional generic
extensions. A distribution owns its entry and passes those extensions.

The UI exports its mount function, extension contracts, selected reusable components and
Vite configuration. A distribution owns its page and mounts its extensions.

The optional `UiExtension.conversationRow` pure function receives a `ConversationRow`
with its role and original text. User rows have kind `user`; notice rows have kind
`notice` and a `noticeKind` when one was parsed. Return `{ label, text }` for a user
row to show a source label and display text, or `{ summary }` for a notice to show a
closed disclosure. Return nothing to keep the default presentation. The original text
remains available for copy and resend. Errors fall back to the default presentation.
Extensions are consulted in registration order until one returns a result.

## Extension outbox

An authenticated edge route can enqueue input in Salon's durable outbox through
`ctx.outbox`. Import `EdgeExtension`, `EdgeOutboxInput`, `EdgeOutboxRecord` and
`EdgeOutboxError` from `@agent-console/edge/extensions`. An adapter supplies the
exact target and its own trusted source metadata after checking its channel
grant and resolving the recipient. For example, a write route can admit:

```ts
const result = await ctx.outbox.admit({
  inputId: "example-input",
  target: {
    machine: "example",
    sessionId: "example-session",
    sessionIncarnation: "example-incarnation",
  },
  text: "Example reply",
  source: { channel: "companion", label: "Companion device", prefix: "(companion) " },
});
ctx.sendJson(result.status, result);
```

The facade requires a persistent edge state database. Admission needs a
CSRF-checked write route. Every call uses the request's authenticated principal
and device, the current route permission and the exact target's session grant
in multi-user mode. The edge rechecks authorization after daemon observation.
Before provider submission, the shared dispatcher checks the original route
permission, principal, session and issuing device again. Adapters enforce their
own channel and recipient policy before calling `admit`.

The input ID is opaque and scoped to the principal, extension and channel. Use
1–128 letters, digits, periods, underscores or hyphens for the ID and a
lowercase channel name of up to 64 characters using letters, digits and
hyphens. A new input returns `201`. The same ID, exact target, text and source
return the existing record with `200`. Changing the target, text, label or
prefix for an existing key returns `409 input-id-conflict`.

The record stores `channel`, `label` and `prefix` as structured source fields.
Salon adds the trusted prefix and its separator once when composing the
provider prompt. The user bubble then includes the prefix from that prompt.
Supply the label and prefix from trusted adapter metadata, independent of the
user text. The complete prompt is limited to 16 KiB of UTF-8.

Call `await ctx.outbox.get({ channel, inputId })` before resolving a target or
to poll the same admission. An absent key in the caller's namespace returns
`404 input-not-found`. For an existing key, the edge verifies access to its
stored exact target before returning the record. Read and replay require the
target incarnation to be observable. A successful read returns `200` even
when the delivery state is pending, refused or unknown. The record includes
the outbox intent ID, state, revision, timestamps in Unix milliseconds and
the request ID, receipt and delivery error code when available.

Both methods return a discriminated result with `ok` and `status`. On
success, use `record`. On failure, use the typed `error.code`. An accepted
input enters the shared dispatcher, where its state and receipt reflect
provider submission.

### Admit on behalf of the target's owner

A route whose recipient authority is external can set `outboxOwnerDispatch: true`.
The capability is off by default and applies only to that route. The route must then pass
`ownerPrincipalId` to `admit`, the owner that its authority asserts for the exact target.
Without the capability, any `ownerPrincipalId` returns `403 forbidden`. With it, a missing
value returns `400 invalid-request`; there is no wildcard and no fallback to the caller.

The edge accepts the input only when the caller holds the route permission and can access the
target machine, and the asserted owner currently owns that exact session incarnation.
The record is dispatched as the owner and stores the caller for audit.
Every dispatch attempt checks again that the capability exists, the caller still holds the
permission and machine access, and the owner still owns the incarnation.
An ownership change refuses the queued item with `outbox-authorization-changed`.

On-behalf records are not readable through `ctx.conversation` unless the reading route sets the
separate, default-off `outboxOwnerReplyRead: true`. That capability is not implied by
`outboxOwnerDispatch`. The read returns only the first reply after that record's own submission
receipt, in its exact incarnation.
The caller's query must name the caller's own stored record and
its exact target. Every read repeats the admission checks and requires the history to belong to the
owner. A failed check returns `forbidden`. No other history of the owner is readable.

Residual risk: a holder of the route permission on a capability route can queue prompts into any
exact session incarnation it can name, for that session's current owner. This applies on every
machine the caller and the owner can both access. Grant the permission only to an adapter
that enforces its own recipient policy.

The outbox store keeps the caller in the existing admission record, so there is no schema
change and no migration. Rolling back to a build without the capability leaves the item
queued under the owner. That build refuses it unless the owner also holds the route permission.

See [package consumption](package-consumption.md) for the local producer and isolated
installed-package check.

## First reply to an extension input

Use `ctx.conversation.firstReplyAfter` to read one assistant text message after
an input that the same extension delivered. Pass the session list's exact
`created_at` and `session_incarnation` along with the machine and session ID.
Use either the outbox record's `outboxIntentId` or its submitted receipt's
`request_id` as `receiptRequestId`. The facade resolves both from the
authenticated principal and extension's durable outbox.

```ts
const result = await ctx.conversation.firstReplyAfter({
  target: { machine, sessionId, sessionCreatedAt, sessionIncarnation },
  outboxIntentId: record.outboxIntentId,
});
if (result.status === "found") {
  const { event_id, order, text, created_at } = result.reply;
  // Use event_id to claim the reply before delivering text to the channel.
}
```

Import `EdgeConversation`, `EdgeFirstReplyQuery`, `EdgeFirstReplyResult` and
`EDGE_FIRST_REPLY_MAX_TEXT_BYTES` from `@agent-console/edge/extensions`.
The session list advertises `data.capabilities.extension_first_reply` when
authenticated requests can use the facade with a persistent outbox.
Each read checks the current route, the original admission grant and access to
the exact session and its history. Adapters apply their own channel grant
before calling the facade.

| Status | Meaning |
| --- | --- |
| `found` | The reply includes a provider-neutral event ID, numeric order, text and the history timestamp. Text is capped at 16 KiB of UTF-8. |
| `none_yet` | The input is bound in the observed history and no later assistant text message appears in that window. |
| `wrong_incarnation` | The submitted input, session identity or history binding conflicts with the requested incarnation. |
| `unavailable` | The reason describes missing receipt, session, history or ordering evidence. A later poll can pick up newly available evidence. |
| `invalid_request`, `unauthenticated`, `forbidden` | The query or its access checks failed. |

Codex history places the submitted request on its user row via the daemon's
`prompt_request` binding. The facade selects the first assistant text row
after that anchor when the history fits in one bounded read of up to 100
provider rows. Codex transcript byte offsets establish the sequence relative
to the receipt.

The public `order` is the assistant row's Unix timestamp in milliseconds,
after verifying that those timestamps strictly increase in the window's
assistant text sequence. Tied, reversed or missing assistant timestamps and
a compaction boundary after the anchor return `unavailable`. Longer histories,
incomplete reads and missing anchors also return `unavailable`.

The event ID is derived from the target, history identity, assistant timestamp
and full text. Moving an otherwise unchanged row to a different byte offset
preserves both its event ID and its order. Compare positions for the exact
target and use the event ID as an opaque claim key.

Claude history exposes transcript order. The current daemon lacks an
authoritative binding from its submitted prompt receipt to a user history row,
so the facade returns `unavailable` with `provider_order_unavailable`.
