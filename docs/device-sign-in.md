# Device sign-in protocol

The edge exchanges an explicitly approved one-time pairing code for an independently revocable device
credential. This note defines the client protocol and security boundaries for
[#504](https://github.com/sympoies/salon/issues/504). Native camera integration and account recovery are out of scope.

## Preserve principal grants and distinguish credential authority

Pairing issues a credential for an existing principal; it never creates ownership, machine or daemon grants.
Application access continues through that principal's current permissions, machine access and session grants.
Explicit bearer credentials remain authoritative over ambient cookies.

Only the configured main credential, or a live browser session authenticated directly with it, may create,
approve or revoke pairings and Renew devices. Paired-device bearers, device cookies and device-derived login
sessions cannot perform those actions. A device bearer plus an ambient main cookie cannot gain main authority.
Preserve credential kind and device identity through token login; do not mint a principal-only session from a
device credential. No configurable enrollment permission or descendant credential graph is added.

Authenticated devices may read their own principal's device metadata and use principal-scoped device
revocation. Revoking a device does not rotate the main token or revoke other devices. Device sessions cannot
enroll successors or renew themselves or others. The UI explains that enrollment and renewal require a main
credential login. Pairing is unavailable in no-auth mode and for managed tester principals; those modes retain
their existing authentication behavior. The configured single-token principal may pair through its main token.

## Create, claim and confirm on both devices

1. Authenticated `POST /api/auth/pairings` creates a pending request bound to the main-authenticated principal
   and source session/credential. Return a public identifier, expiry and pairing code once. Creation is not approval.
2. The sender displays a locally generated QR, manual code and link to the current origin at `/#pair=<code>`.
   The recipient reads the fragment into memory and replaces the history entry with `/` before application
   requests/debug capture. Never store the code or use an external QR service.
3. The recipient generates a private 256-bit verifier in memory and posts its SHA-256 challenge, code, bounded
   display name and browser/native delivery kind to `POST /api/auth/pairings/claim`. The first valid claim binds
   atomically and cannot be replaced. An identical retry is safe; losing recipient memory requires a new request.
4. Claim success returns the canonical target principal and immutable claim metadata. The recipient displays
   that principal and the exact server origin contacted, then requires explicit **Sign in as …** consent before
   exchange polling or credential installation. Bind consent to pairing identifier, principal, full challenge,
   origin and delivery kind. Reset it on changes and discard stale connection results. Cancel leaves existing
   cookies/native storage unchanged. Apply this to browser links, browser code entry and native code entry.
5. Both devices display an 8-character base32 comparison string derived from the full challenge. Owner-only
   `GET /api/auth/pairings/:id` shows the claim. Main-authenticated `POST .../:id/approve` carries the code and
   expected full challenge. Require the same principal, current source/generation and exact immutable claim.
   The sender explicitly confirms the device in hand; its user-supplied name is only display text.
6. After recipient consent, poll `POST /api/auth/pairings/exchange` no faster than every five seconds, carrying
   code, private verifier and the confirmed claim tuple. Validate consent fields, challenge, approval, source,
   principal generation, expiry and revocation. Consume the request and insert one credential in one SQLite
   transaction. Concurrent exchanges yield one success. Lost delivery requires a new pairing; no secret recovery.
7. Browser exchange delivers its device secret only in an HttpOnly, SameSite=Strict, Secure cookie using the
   existing session cookie name, with metadata-only JSON. Native exchange returns the credential once over HTTPS
   and saves it through the existing token storage path. Refuse silent replacement of a different-principal
   browser session. Native code entry uses the configured server; an OS-camera link signs in its target browser.

## Entropy, storage, expiry and throttling

Codes contain 20 independently random base32 characters: 100 bits. Group them for manual entry and normalize
only case/separators. Verifiers and device secrets contain 32 random bytes; public pairing/device identifiers
are independently random and convey no authority. Comparison strings are visual checks; authorization uses
the full challenge. Default pairing TTL is five minutes from creation, configurable to 60–600 seconds through
`AGENT_CONSOLE_PAIRING_TTL_SECONDS`. Claim/approval/polling never extend it. Owner cancellation through
`DELETE /api/auth/pairings/:id`, expiry or source invalidation blocks approval/exchange.

New tables use the existing state database and its in-memory behavior without a persistent path. Retain only
SHA-256 code/device-secret hashes, challenge, principal/source references, timestamps and state. Bind current
main-credential generation using an HMAC keyed by the presented pairing code or device secret; neither the
key nor an offline verifier for the main token is stored. Recompute at approval/exchange/authentication.
Conditional transactions enforce single use; retained state survives edge replacement.

Limit pairing operations to 60/minute per socket address and 120/minute per known owner, creation to 5/10 minutes
per owner, and active requests to 3 per owner. Device-authenticated metadata operations use a separate
120/minute budget per device; anonymous known-code attempts use a separate 120/minute owner budget.
Neither can consume the main credential's management budget or prevent selective revocation. Count failures
and polling.

Bound bodies to 2 KiB, prune counters and expire requests. Cap address buckets at 10,000 without
using that capacity for authenticated owner, device or creation counters. Upgrading the counter schema resets
only transient rate counters; pairing requests and credentials are preserved.

Do not trust forwarded client addresses;
reverse-proxy clients share that proxy's address budget. Address throttling returns a uniform 429 independent
of code existence. Owner-budget refusal on anonymous routes uses the generic invalid-pairing response.
Unknown, pending, expired, revoked, consumed and wrong-verifier exchanges share one failure status/body;
owner operations use the same not-found response for missing and other-principal identifiers.

## Fixed device expiry and browser transport

Device authorization expires 30 days after issue. Reads, activity, last-used updates and cookie refresh never
change `expires_at`. Main-token browser sessions retain their existing fixed 12-hour lifetime. Browser device
cookies authenticate directly against their own credential record, preserving its identity, generation,
revocation and server-authoritative expiry; they are not translated into ordinary 12-hour main sessions.

To allow a main session to Renew a different browser device, decouple transport-cookie retention from device
authorization expiry. Set the device cookie's storage Max-Age to 90 days and refresh that storage retention on
successful device HTTP authentication. This only retains the presented secret; it never renews its database
authorization. The server still refuses an unrenewed credential at exactly its 30-day expiry, even with a retained
cookie. Logout revokes the current browser device credential and clears its cookie.

Renewing a selected browser device updates its credential record, so its existing retained cookie immediately
uses the new server expiry without needing a response on that other browser. Every authenticated use checks
the record. No automatic Renew occurs. A browser that has cleared/expired its transport cookie must pair again;
Renew cannot restore a missing client secret. Native local storage has the same missing-secret limitation.
Acceptance distinguishes retained-cookie authentication from the server's fixed authorization deadline.

## Explicit Renew, audit and metadata

`POST /api/auth/devices/:id/renew` requires main authentication and the existing write/origin gate. In one
transaction, conditionally update only an unrevoked device belonging to that principal with `expires_at > now`,
setting expiry to the transaction's `now + 30 days`, and append its audit. Another principal, a missing/revoked
target or an expired target is refused. A prior revoke/expiry cannot be resurrected; a later revoke remains final.

Audit records contain acting principal, credential kind, target identifier, time and previous/new expiry;
never bearer/cookie values or hashes. Return metadata only. Device credentials cannot call Renew, including
through derived cookies/login or with an ambient main cookie.

Authenticated `GET /api/auth/devices` lists only that principal's device identifiers, display names, principal,
created, last-used and `expires_at` timestamps, revocation state and current-device marker. Device credentials
may read it. Successful authentication updates last-used without renewing expiry. No secrets/hashes appear.
Document the metadata call for expiry reminders using a private curl authentication configuration:

```sh
curl --config "$SALON_AUTH_CONFIG" "$SALON_ORIGIN/api/auth/devices"
```

`DELETE /api/auth/devices/:id` keeps principal-scoped selective revocation. Main-token removal/rotation also
invalidates device credentials and pending pairings. Carry device identity through cookies, attach tickets,
downloads, SSE and WebSockets; reject stale tickets/writes and stop streamed output after revocation, closing
idle streams within the existing 250 ms interval. Existing tester-only guards must be extended for devices.

Durable outbox intentions retain their issuing public device identifier alongside the existing main/machine
generation binding, never the device secret. Refuse pending device work immediately on revocation and recheck
device activity before dispatch, including after daemon observations and edge replacement. Expiry and
revocation cannot transfer queued work to the main credential; other active devices and main intentions
continue normally. Already dispatched or uncertain provider actions cannot be retracted.

Recheck the captured credential immediately before protected writes after asynchronous work, including local
settings, controller calls and ownership updates. Rejecting a response after a write cannot undo that write.
Extension `readJsonBody` rechecks authorization before returning the body. Extension handlers that await other
work must call `ctx.assertAuthorized()` immediately before a side effect; the check retains the exact credential.

## Origin checks, secrecy and threats

Authenticated writes retain the existing CSRF checks. Anonymous claim/exchange use JSON POST and the existing
strict same-origin predicate; a pairing code is never an origin exemption. Verify the native plugin transport
before native UI; unexpected Origin behavior needs review, not a new exemption. Use the existing HTTPS
deployment boundary and reject insecure pairing destinations in production clients; enforce native HTTPS and
refuse redirect-based downgrade.

The edge independently requires secure transport on all pairing routes. A TLS socket qualifies directly.
For TLS termination, configure `AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS` with comma-separated exact IP
literals for the immediate proxies. Only a matching socket peer with exactly `X-Forwarded-Proto: https`
qualifies. The default list is empty; names, ranges and empty entries are rejected. The trusted proxy must
overwrite that header from its actual TLS connection and prevent clients from bypassing TLS termination.

Other forwarding headers, body fields and Origin never prove secure transport. Refuse plaintext before
creating a code, binding a claim or delivering a credential; refusal does not consume an approved request.
For local HTTP development, the existing `AGENT_CONSOLE_INSECURE_COOKIE=1` opt-in requires loopback socket
endpoints and a loopback request host. It does not authorize plaintext production pairing.

Keep codes/verifiers/credentials out of paths, queries, redirects, errors, analytics and persistent debug state.
Use no-store responses and no-referrer on the landing document. Only intended QR/link display, one-time code
creation, native exchange and cookie delivery expose their required secrets. Status/list/errors never do.
Sanitize pairing parse/database errors before the general exception logger. Fragment cleanup cannot erase
copied links or browser/OS records created before application execution; short TTL and both confirmations matter.

| Threat | Mitigation and limit |
| --- | --- |
| Shoulder-surfed QR | Compare the claimant before owner approval; code alone cannot exchange. First-claim interference can require cancellation/retry. |
| Forwarded link | Owner confirms claimant; recipient confirms server/principal before exchange. Deliberately accepting a misleading account/device remains phishing risk. |
| Replay | Immutable challenge, full verifier and transactional single consumption survive concurrency/restart. |
| Brute force | 100-bit code, bounded TTL, address/owner limits and uniform failures. |
| Stolen device | Independent revocation, 30-day server expiry and stream/ticket invalidation. Devices cannot enroll or Renew; prior actions/copied data cannot be undone. |

Compromised clients, same-origin scripts and compromised TLS termination are outside the protocol's protection.
No constant-time network response guarantee is claimed.

## Acceptance coverage

The HTTP acceptance suite covers: code expiry, approval, wrong principal/verifier,
immutable claim, cancellation, concurrent single use, source/main-generation changes, rates and failure-oracle
behavior. Test both recipient confirmations, unsolicited remotely approved links, cancel/reset and no pre-consent
cookie/native installation. Device bearer/cookie/login and device-bearer-plus-main-cookie must fail enrollment,
pairing cancellation and Renew; main authentication must succeed under the existing origin gate.

Test exact 30-day authorization expiry with a retained browser cookie, unchanged expiry under reads/cookie
refresh/activity, explicit main-authorized Renew to now + 30 days and selected-browser authentication beyond
its original authorization deadline. Refuse wrong-principal/revoked/expired renewal. Exercise transactional
renew/audit and revoke ordering; metadata/audit must omit secrets/hashes. Test bearer/cookie/ticket/stream
revocation, original token behavior and unchanged no-auth/tester restrictions.

Check synthetic secret sentinels against SQLite rows, logs/debug events, malformed-body errors, listing,
unrelated responses and retained URLs, allowing only intended delivery surfaces. Client acceptance also covers
synthetic sender, recipient and device-list UI at widths 390 and 1280.
The project gate checks the edge contract; real native transport acceptance remains a separate check.

## Evidence

Source inspected at `1934334e0aa1a5a8aaf5aa0a679bd26fd1029b59`: edge auth/server/config/csrf/accessStore,
testCredentials/http, UI runtime/api/Login/Settings/debugLog and existing authentication tests.
The owner requirements are recorded in [#504](https://github.com/sympoies/salon/issues/504).
The design follows the device-confirmation/phishing considerations in
[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html#section-5) and secret exclusion in
[OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude).
It is a Salon pairing protocol, not an OAuth interoperability implementation.
The implementation and its validation results are recorded with the corresponding change.
