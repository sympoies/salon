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

See [package consumption](package-consumption.md) for the local producer and isolated
installed-package check.
