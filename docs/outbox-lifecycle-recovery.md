# Outbox lifecycle recovery

Archive and delete acquire a durable machine/session fence before upstream
mutation. New fences record a unique ownership token, the expected incarnation
when available, and whether the upstream operation is incarnation-bound.

Admission and explicit Retry capture the fence before querying the daemon.
They may release it only when the daemon successfully reports the same session
running with a different incarnation and the exact stored token, incarnation
and binding flag still match. A concurrent acquisition or repair invalidates
that proof. The admission transaction checks the fence again, so an operation
acquired after observation still blocks input.

A validated successful archive or a definite pre-action refusal releases only
its acquiring token. Malformed acknowledgements and uncertain current-incarnation
operations retain their fences. Missing sessions, unavailable observations,
non-running sessions and elapsed time do not prove replacement.

Maintenance delete supplies its expected incarnation. Direct DELETE does not
bind its upstream action to an incarnation; its fence records an observation
when already available, otherwise a null incarnation, and cannot recover
automatically from replacement while its outcome is uncertain.

## Existing stores

Opening an existing store adds the provenance columns transactionally. Every
legacy row receives a unique, persistent ownership token. Its incarnation
remains null and its binding flag remains false. Nothing infers provenance from
old reply targets, history, elapsed time or the currently running incarnation:
a legacy fence could protect a later uncertain operation that admitted no
replies. All edge writers must be upgraded together; do not run an old writer
against the migrated store.

A legacy fence stays closed until an operator verifies its provenance. Automatic
recovery of arbitrary legacy operations would need authoritative lifecycle
evidence from the daemon. No bulk deletion or expiry is provided.

## Repair one verified completed archive

Run the owner-local command as the database owner, with the edge package
installed. The database, proof file and saved dry-run plan must be private
regular files owned by that user (mode 0600). Keep their contents local;
they are operational evidence and must not be committed or posted publicly.

1. Inspect exactly one row:

   ```bash
   agent-console-outbox-lifecycle --db "$STATE_DB" --machine "$MACHINE" --session "$SESSION"
   ```

2. Independently verify that this legacy row belongs to a completed archive,
   identify the original request's expected incarnation, and retain its validated
   daemon acknowledgement. Check that no later operation owns this row. A
   running session alone, an old reply target or an unrelated archive response
   does not establish this binding. If these facts cannot be verified, stop
   and leave the fence intact.

3. Create a private JSON proof with this shape. All values below are synthetic;
   use the inspected owner token and the verified original daemon result:

   ```json
   {
     "schema_version": "outbox-archive-proof.v1",
     "machine": "fixture",
     "session_id": "example-session",
     "owner_token": "inspected-token",
     "fenced_incarnation": "earlier-incarnation",
     "verified_completed_archive": true,
     "archive_result": {
       "status": 200,
       "body": {
         "ok": true,
         "data": {
           "archived": {
             "history_id": "example-history",
             "provider": "codex",
             "provider_session_id": "example-thread",
             "cwd": "/work/example",
             "created_at": "2030-01-01T00:00:00Z",
             "updated_at": "2030-01-01T00:00:01Z",
             "archived_at": "2030-01-01T00:00:02Z"
           },
           "deleted": {
             "id": "example-session",
             "deleted": true,
             "killed": true,
             "cleanup_pending": false
           }
         }
       }
     }
   }
   ```

   The explicit verification is an operator attestation that binds the row and
   original archive request; the command validates the acknowledgement shape,
   session identity and exact row token. It cannot independently reconstruct
   missing historical provenance or authenticate a fabricated proof.

4. Save and inspect the dry-run plan. It does not assign provenance or release
   admission:

   ```bash
   umask 077
   agent-console-outbox-lifecycle --db "$STATE_DB" --machine "$MACHINE" --session "$SESSION" \
     --proof-file "$ARCHIVE_PROOF" > "$REPAIR_PLAN"
   ```

5. Apply that exact plan with the unchanged proof:

   ```bash
   agent-console-outbox-lifecycle --db "$STATE_DB" --machine "$MACHINE" --session "$SESSION" \
     --proof-file "$ARCHIVE_PROOF" --apply-plan "$REPAIR_PLAN"
   ```

   This compare-and-swap only assigns the verified archive incarnation and
   binding to the named legacy row. Missing proof, an invalid acknowledgement,
   changed proof or a changed row refuses repair. Other rows remain untouched.
   The command cannot repair an uncertain direct DELETE or a new provenance-bearing
   fence.

6. Send a deliberate reply or explicitly Retry through the edge. The edge must
   independently confirm a different running incarnation before releasing the
   repaired fence with another exact-row compare-and-swap. Until that succeeds,
   admission remains fenced. No reply is submitted by the repair command.
