# Companion inbox v1

A session can put a short prompter message in its owner's inbox. Paired devices can
poll that inbox and acknowledge messages. A message's reply target is the exact
session incarnation that produced it.

## List messages

Send `GET /api/prompter/v1/messages?limit=20&cursor=<cursor>`. Supply a live
paired-device bearer or a paired browser's device cookie. An explicit credential
takes precedence over cookies. The edge derives the owner from the credential.
Main credentials, managed tester credentials and no-auth mode cannot use the
inbox. Expiry, revocation and main credential changes follow the
[device sign-in protocol](device-sign-in.md).

A successful response is HTTP 200:

```json
{
  "ok": true,
  "data": {
    "messages": [
      {
        "id": "12345678901234567890",
        "sender": "example-session",
        "body": "Which draft should we use?",
        "created_at": "2026-01-01T12:00:00.000Z",
        "color": "#C2E5F2",
        "urgent": true,
        "target": {
          "machine": "workstation",
          "session_id": "example-session",
          "incarnation": "example-incarnation"
        }
      }
    ],
    "next_cursor": "12345678901234567890"
  }
}
```

An ID is an opaque unsigned 64-bit decimal string. Keep it as a string. The edge
sets `created_at` in UTC and derives `sender` from the source session ID. The
optional `color` and `urgent` fields are omitted when the producer omits them.
Display the body as plain text.

The default limit is 20, with an inclusive range of 1 to 100. Omit `cursor` to
start at the oldest retained message. The edge lists messages in insertion order,
including acknowledged messages. Each page advances `next_cursor` to its last
message. An empty page returns the input cursor, or `null` when none was supplied.
Poll again from that position to see new messages.

Save the cursor after processing the page. Reusing an earlier cursor can replay
messages with the same IDs. Deduplicate by ID, and omit the cursor to replay the
retained inbox after a lost checkpoint or HTTP 410. Cursors are owner-scoped and
usable while their anchor messages are retained. A syntactically valid cursor
that cannot be resolved for the owner returns the same HTTP 410.

Messages and their acknowledgement records are available for seven days from
creation. The edge persists them across restart when a state database is
configured. An owner can have up to 1,000 retained messages. At capacity,
ingress returns HTTP 429 until space becomes available.

## Acknowledge a message

Send `POST /api/prompter/v1/messages/<id>/ack` with the same device authentication
and an `application/json` body:

```json
{
  "state": "displayed",
  "idempotency_key": "0e4080c1-72d4-428c-a7b7-0e08c336d671"
}
```

Use `displayed` after presentation and `read` after a read action. The stored
state for an owner's message only advances, with `read` taking precedence.
Success is HTTP 200 with `{"ok":true,"data":{"id":"12345678901234567890","state":"displayed"}}`.
The receipt reports the effective state at the time of the acknowledgement.

Use a fresh key for each logical acknowledgement and reuse it on retry. A key
has 1 to 128 ASCII letters, digits, periods, underscores or hyphens. It is
scoped to the owner and retained with its message. The same key, message and
requested state return the original receipt. Reusing a key with a different
message or state returns HTTP 409 when the requested message is visible to the
owner. Each message accepts up to 64 distinct keys. Retries of accepted keys
work at that limit. A missing, expired or foreign message returns HTTP 404.

Use the edge's normal origin check for cookie-authenticated writes. The
request body limit is 1 KiB.

## Submit from an owned session

The producer's daemon sends `POST /api/coordination/prompter/v1/messages` with
its configured relay bearer and an `application/json` body:

```json
{
  "source_session_id": "example-session",
  "source_incarnation": "example-incarnation",
  "body": "Which draft should we use?",
  "color": "#C2E5F2",
  "urgent": true
}
```

The edge takes the machine from the authenticated relay. It requires a current
coordination-capable source session on that machine, an exact ownership grant
and a configured owner with access to the machine. Producer ingress requires
multi-user ownership storage. An owner's coordinator session can use this same
route with its own session identity. The source grant determines the only owner
and target. Cross-owner messaging rules and service admissions grant no inbox
authority. The request accepts only the fields shown above.

The body must contain non-whitespace text and fit in 4,096 UTF-8 bytes. The
optional `color` is a six-digit hexadecimal RGB string with a leading `#`.
The optional `urgent` is a boolean. The JSON request limit is 32 KiB. Success
is HTTP 201 with `{"ok":true,"data":{"id":"12345678901234567890"}}`. Each
accepted submission creates a message. If the result is lost, check the inbox
before resubmitting to avoid a second message.

## Handle errors

Responses use `Cache-Control: no-store`. Failures carry
`{"ok":false,"error":{"code":"invalid-request","message":"Invalid request."}}`.
Branch on the code. Error messages, logs and diagnostic events omit credentials
and message bodies.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid-request` | Invalid query, JSON, fields or field format. |
| 401 | `unauthorized` | Missing, invalid, expired or revoked credential. |
| 403 | `device-required` | List or ack was called with another credential kind. |
| 403 | `cross-origin` | A cookie-authenticated write failed the origin check. |
| 403 | `source-forbidden` | The producer has no eligible source grant. |
| 404 | `message-not-found` | The message is unavailable to this owner. |
| 405 | `method-not-allowed` | The HTTP method is unsupported. |
| 409 | `idempotency-key-conflict` | The acknowledgement key already describes another request. |
| 409 | `session-incarnation-conflict` | The producer session has been replaced. |
| 410 | `cursor-expired` | The cursor has no retained anchor in this owner's inbox. |
| 413 | `body-too-large` | The request or message exceeds its byte limit. |
| 429 | `inbox-full` | The owner's retained inbox is at capacity. |
| 429 | `ack-limit` | The message has reached its distinct acknowledgement key limit. |
| 500 | `inbox-error` | The edge could not complete the inbox operation. |
| 503 | `source-unavailable` | Producer ingress or the source snapshot is unavailable. |
