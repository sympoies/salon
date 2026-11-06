# Salon

Salon is a self-hostable, container-first chat workspace for working with
coding agents from a browser. Start a session, talk to it, and reconnect to the
same session later.

Salon is being bootstrapped. The shared, edge and UI core libraries can be built
and packed locally, but the first usable application milestone is still pending.
Library checks do not establish container startup or provider acceptance.

## Preview

<p>
  <img src="docs/assets/readme/desktop-dark-1280.png" width="73.62%"
    alt="Salon in the Dark theme on a desktop browser: three session tiles,
      with the retry-backoff conversation open on the left, showing a plan,
      a diff, a test result, a chart and a scheduled notice">
  <img src="docs/assets/readme/phone-paper-390.png" width="24.38%"
    alt="Salon in the Paper theme on a phone: the retry-backoff conversation
      with a plan, a diff and a test result, and a reply composer at the bottom">
</p>

*UI preview with synthetic data: desktop in the Dark theme, phone in the Paper theme*

The previews show the UI core rendered with fictional sessions served by a
stand-in daemon. They are not a provider session. See
[DEVELOPMENT.md](DEVELOPMENT.md#ui-previews) to regenerate them.

## What works today and what is planned

The reusable core libraries produce JavaScript, declarations and required assets.
An isolated package consumer exercises those artifacts without workspace source
links. See [package consumption](docs/package-consumption.md) for that developer path.

The first developer milestone will support one provider. The full MVP will
support two providers. The intended user flow for those milestones is:

1. Start the workspace with `docker compose up --build`.
2. Complete official provider login or API-key setup.
3. Create a session and send a prompt.
4. Receive an actual provider reply.
5. Refresh the browser or reconnect to the same session.

These are planned application acceptance steps. The local core package checks
do not establish them.

## Read session previews and restore drafts

The UI core's session overview cards show the latest user or agent message when available.
For older servers, they fall back to the last user prompt. In Settings,
**Card preview** offers **Latest message** (default) and **My last prompt**.
The choice is saved on the current device, including on the mobile layout.

When the session runtime saves a draft, Salon marks the session with its save
time. Open its conversation to read saved drafts and restore one to the reply
composer. Replacing existing text requires confirmation. Restoring does not
send the draft.

## Track outgoing replies and attachments

When a session is replaced or removed, Salon automatically clears its
unconfirmed outgoing replies across clients once the server confirms the
change. Cached replies disappear when the conversation next syncs. This does
not retract messages already delivered.

Outgoing attachments show their sanitized upload names in this browser's outbox.
Newly attached raster images also have a local preview while the reply is pending
or refused. History shows the original name when the session runtime supplies
it; otherwise it uses the neutral image label.

Refused external Markdown images show their source origin and an **Open link**
action. Salon loads no external image; opening the link uses your browser.

Other files appear as cards with an original name or neutral kind, their size
when known, and a copy icon. Long names stay on one line while keeping the
extension visible. Select a file card to copy its file path.

## Contribute to Salon

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites and validation, and
[AGENTS.md](AGENTS.md) for contributor instructions. Durable implementation
context is recorded in the [development log](docs/devlog/README.md).

## License

[MIT](LICENSE), copyright Salon contributors.
Bundled fonts retain their separate
[SIL Open Font License and notices](packages/ui/src/fonts/LICENSE.md).
