# Service console starts

An explicitly admitted deterministic service can start a console-owned root
session through the coordination relay without being a session itself. The
daemon side is the "Service Console starts v1" section of
[session-coordination-v1.md](https://github.com/sympoies/nils-cli/blob/main/crates/agent-session/docs/specs/session-coordination-v1.md).
This page covers the edge side.

## Admission

`AGENT_CONSOLE_CONSOLE_START_SERVICES` is a JSON array. Omitting it refuses every
service.

```json
[
  {
    "relay_machine": "host-a",
    "service_id": "integration",
    "service_generation": "generation-1",
    "owners": ["owner-a"],
    "machines": ["host-a", "host-b"]
  }
]
```

`relay_machine` must have an `AGENT_CONSOLE_COORDINATION_RELAYS` entry; the
service daemon authenticates with that relay's token. `owners` must be configured
principals other than `root`, and `machines` must be configured machines. A
request is admitted only when its target machine is also in the owner's own
machine allowlist. To rotate a generation without downtime, list both generations
as separate entries, then remove the old one.

## Create

`POST /api/coordination/sessions/v1` with the relay bearer and an
`x-agent-session-operation-id` UUIDv7 header:

```json
{
  "source_service_id": "integration",
  "source_service_generation": "generation-1",
  "owner": "owner-a",
  "machine": "host-a",
  "session": {"agent": "claude", "cwd": "/abs/path", "lineage": {"…": "…"}}
}
```

The request may not carry `source_session_id` or `source_incarnation`. The
`session` lineage must be a console root. `session` may not set `id`, `resume`,
`role`, `work` or `origin`. The created session belongs to `owner` and has no
launcher, dispatcher or coordinator tree.

| Code | HTTP | Cause |
| --- | --- | --- |
| `console-start-service-unauthorized` | 403 | no admission for this relay machine, service and generation |
| `console-start-service-owner-denied` | 422 | `owner` is not admitted for the service |
| `console-start-service-target-denied` | 422 | `machine` is not admitted for the service, or not available to the owner |
| `invalid-request`, `lineage-invalid` | 400 | malformed request or operation id |
| `console-start-operation-conflict` | 409 | the operation id belongs to a different request |
| `console-start-unavailable` | 409 | the operation has no confirmed session |

## Idempotency

The access database reserves relay machine, service ID and operation ID before
any daemon call, and keeps the record. An identical request replays
`{"ok": true, "data": {"session": {"id", "agent", "session_incarnation"}}}` with
HTTP 201 and never reaches the target daemon, including after a generation
rotation. An operation that failed is never recreated: submit a new operation
id. An operation whose outcome is unknown can leave a running session with no
owner, which neither a retry nor the scan reveals, so check the target machine
before submitting a new id.

## Board scan

`GET /api/coordination/board/v1?source_service_id=&source_service_generation=&owner=&machine=`
passes the same admission and answers an `agent-session.board-view.v1`. It holds
only sessions this service started, under any generation, that are owned by
`owner` on `machine` and have a lineage with `parent: null`. Session-scoped
parameters are refused on this query.
