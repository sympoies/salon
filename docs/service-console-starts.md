# Service admission and console starts

An admitted service can discover and message sessions, start console-owned root
sessions, or do both through the coordination relay. The service has its own identity.

The daemon side is the "Service Console starts v1" section of
[session-coordination-v1.md][daemon-spec].

## Admission

`AGENT_CONSOLE_CONSOLE_START_SERVICES` is a JSON array. Omitting it refuses every service.

```json
[
  {
    "relay_machine": "host-a",
    "service_id": "integration",
    "service_generation": "generation-1",
    "capabilities": ["message"],
    "owners": ["owner-a"],
    "machines": ["host-a", "host-b"]
  }
]
```

Every entry requires a nonempty `capabilities` array. List one or both of the
following values.

- `message` allows peer discovery and relayed service messages.
- `console-start` allows console-root session creation and board scans for
  sessions the service started.

To migrate an existing deployment, add `capabilities` to each entry before
upgrading. Use `["message", "console-start"]` to retain both grants or list only
the capability the service needs. Missing or unknown capabilities cause
configuration loading to fail.

`relay_machine` must have an `AGENT_CONSOLE_COORDINATION_RELAYS` entry; the service daemon
authenticates with that relay's token. `owners` must be configured principals other than
`root`, and `machines` must be configured machines. A request is admitted only when its
target machine is also in the owner's own machine allowlist.

An entry may also set `"console_role": "coordinator"`, the only accepted value. Roots
that entry creates then carry the same role as a coordinator root started through Console,
at coordinator tree depth 0, so cross-owner messaging rules that select `{"role":
"coordinator"}` match them as sender or recipient. Without the field a root has no role.
Only the admission entry decides the role: a create request cannot carry one.

To rotate a generation without downtime, list both generations as separate entries, then
remove the old one.

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

The request may not carry `source_session_id` or `source_incarnation`. The `session`
lineage must be a console root. `session` may not set `id`, `resume`, `role`, `work` or
`origin`.

The created session belongs to `owner` and has no launcher or dispatcher. It sits outside
the coordinator tree unless the admission entry sets `console_role`.

| Code | HTTP | Cause |
| --- | --- | --- |
| `console-start-service-unauthorized` | 403 | no `console-start` admission for this relay machine, service and generation |
| `console-start-service-owner-denied` | 422 | `owner` is not admitted for the service |
| `console-start-service-target-denied` | 422 | `machine` is not admitted for the service, or not available to the owner |
| `invalid-request`, `lineage-invalid` | 400 | malformed request or operation id |
| `console-start-operation-conflict` | 409 | the operation id belongs to a different request |
| `console-start-unavailable` | 409 | the operation has no confirmed session |

## Idempotency

The access database reserves relay machine, service ID and operation ID before any daemon
call, and keeps the record.

An identical request replays `{"ok": true, "data": {"session": {"id", "agent",
"session_incarnation"}}}` with HTTP 201 and never reaches the target daemon, including
after a generation rotation. The role recorded by the first create stays.

An operation that failed is never recreated: submit a new operation id.

An operation whose outcome is unknown can leave a running session with no owner, which
neither a retry nor the scan reveals, so check the target machine before submitting a new
id.

## Board scan

`GET /api/coordination/board/v1?source_service_id=&source_service_generation=&owner=&machine=`
passes the same admission and answers an `agent-session.board-view.v1`. It holds only
sessions this service started, under any generation, that are owned by `owner` on
`machine` and have a lineage with `parent: null`. Session-scoped parameters are refused on
this query.

## Peer discovery and message delivery

Send `GET /api/coordination/peers/v1` with the relay bearer and the
`source_service_id` and `source_service_generation` query parameters. The edge
derives the caller's machine from the bearer. Discovery returns peers owned by
the service's admitted principals on machines allowed by both the admission and
the peer's owner.

The relay accepts the runtime's `agent-session.remote-service-message.v1` and
`agent-session.remote-service-message.v2` envelopes. The edge checks the same
admission against the source and recipient and preserves the service origin
through delivery. The recipient remains a session. The current runtime refuses
replies to a service origin.

Without a `message` admission for the authenticated relay, service and
generation, both routes return HTTP 403 with `coordination-unauthorized`.
Sending to an existing recipient outside the admitted owner and machine scope
returns HTTP 403 with `principal-forbidden`.

[daemon-spec]: https://github.com/sympoies/nils-cli/blob/main/crates/agent-session/docs/specs/session-coordination-v1.md
