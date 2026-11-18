# Companion reply v1

A paired companion can submit a physically confirmed owner reply to the session
that originated a [Companion inbox v1][inbox] message. The reply is a single
attempt to submit a provider prompt to that exact session incarnation.

## Confirm and send a reply

Show the owner the message, target and exact reply text. Send the request only
after the owner explicitly confirms that reply on the device in hand. Changes
to the message, target or reply text require fresh confirmation and a fresh key.

Send `POST /api/prompter/v1/replies` with an `application/json` body.

```json
{
  "idempotency_key": "c7dd04e2-9ad2-4c23-b17f-a15d9f9625ab",
  "message_id": "12345678901234567890",
  "target": {
    "machine": "workstation",
    "session_id": "example-session",
    "incarnation": "example-incarnation"
  },
  "text": "Use the second draft.",
  "confirmation": "physical"
}
```

Copy the decimal string message ID and the exact `target` object from the inbox
message. Use an idempotency key of 1 to 128 ASCII letters, digits, periods,
underscores or hyphens. The request accepts only the shown fields. Its JSON
limit is 32 KiB. Supply non-whitespace text up to 4,096 UTF-8 bytes. Line feeds
are allowed. Other ASCII control characters and DEL are rejected.

Both routes require a live [paired-device credential][device-sign-in]. An
explicit bearer takes precedence over a cookie. Cookie-authenticated writes
must pass the normal origin check. The device credential identifies the
owner. Main credentials, managed tester credentials and no-auth mode are
ineligible. `physical` is the device's declaration of an explicit confirmation
action. The edge rejects `test` and other confirmation kinds before claiming a
reply.

## Read and recover the receipt

A claimed reply returns HTTP 200.

```json
{
  "ok": true,
  "data": {
    "receipt_id": "938138ad-73d9-47f7-bdf9-731fe09b8d5c",
    "status": "sent"
  }
}
```

| Status | Meaning |
| --- | --- |
| `sent` | The daemon confirmed prompt submission for the claimed incarnation. |
| `busy` | The daemon confirmed the session was busy and refused before submission. |
| `refused` | The edge or daemon confirmed the reply could not be submitted. |
| `uncertain` | Submission is in progress or its result could not be confirmed. |

Send `GET /api/prompter/v1/replies/status?receipt_id=<receipt_id>` or
`GET /api/prompter/v1/replies/status?idempotency_key=<key>`. Use exactly one
selector. A receipt ID is an opaque UUID. Lookups return the same HTTP 200 shape
and require a live device credential for the same owner.

Save the key before submitting. The edge atomically claims keys within the
owner's scope and records the receipt before attempting delivery. If requests
overlap, only the first claim can submit input. The same key, message, target,
text and confirmation return the original receipt with its current status.
Reusing a key with different content for a message visible to the owner
returns a typed conflict.

A status lookup can resolve `uncertain` with a matching daemon receipt. It
never submits input. Use the status lookup after a timeout or an uncertain
result. A missing daemon receipt leaves the result uncertain. A new key starts
a new operation. Use one only for a newly confirmed reply.

Receipts remain available for the inbox message's retention period. Each
message accepts up to 64 distinct reply keys. Existing keys remain usable at
that limit. The edge stores receipt metadata and a request fingerprint in its
state database. Reply text and credentials are omitted from receipt storage,
logs and errors.

## Fence delivery to the originating session

The edge requires the inbox message to belong to the device's owner and the
requested tuple to match the stored tuple. Before dispatch, it checks the live
session, current device credential, machine access and exact ownership grant.
The edge sends a keyed prompt with the expected incarnation to the daemon.
The daemon checks the incarnation at input admission and admits the prompt
only when idle. The edge returns `refused` for a replaced session and never
tries the new incarnation.

The edge prepends the fixed line `[Companion reply]` and a line feed to the
owner's text. The provider conversation receives the resulting text as owner
input with the origin visible. The edge dispatches directly and leaves busy
replies for the owner to reconsider.

## Handle errors

Responses use the inbox's JSON error envelope and `Cache-Control: no-store`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid-request` | Invalid JSON, fields or lookup selector. |
| 401 | `unauthorized` | Missing, invalid, expired or revoked credential. |
| 403 | `device-required` | Another credential kind was used. |
| 403 | `cross-origin` | A cookie-authenticated write failed the origin check. |
| 403 | `confirmation-required` | The confirmation kind is ineligible, including test confirmation. |
| 404 | `message-not-found` | The message is missing, expired or owned by another principal. |
| 404 | `receipt-not-found` | The receipt is missing, expired or owned by another principal. |
| 405 | `method-not-allowed` | The HTTP method is unsupported. |
| 409 | `idempotency-key-conflict` | The key already describes another request. |
| 409 | `reply-target-mismatch` | The requested target differs from the originating message target. |
| 413 | `body-too-large` | The request or reply exceeds its byte limit. |
| 429 | `reply-limit` | The message has reached its distinct reply key limit. |
| 500 | `inbox-error` | The edge could not complete the inbox operation. |

[inbox]: companion-inbox.md
[device-sign-in]: device-sign-in.md
