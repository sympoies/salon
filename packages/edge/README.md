# Edge configuration

Consumers may set `AGENT_CONSOLE_SERVER_VERSION` and `AGENT_CONSOLE_SERVER_BUILD` to
identify the running server in Settings.

Both are optional. Unset or blank values are omitted from the authenticated server-version
response.

## Remote conversation images

The authenticated `GET /api/history/sessions/:machine/:id/remote-image?url=...` route
serves a remote image to a principal allowed to read that history. The URL is the
original URL from the conversation. The route checks history text before each cache
lookup or fetch. For older history, supply the `cursor` and `direction` used to read
the page containing the row. Cross-origin requests are refused. Successful
responses have a private cache header; failures return a typed reason.

The edge keeps a rebuildable disk cache under the Salon state directory
(`$XDG_STATE_HOME/salon`, or `~/.local/state/salon` when unset). Entries are keyed by
the URL hash and evicted by least recent use and age. Cache errors do not prevent
fetching an image.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_CONSOLE_REMOTE_IMAGE_ALLOW_LIST` | empty | Comma-separated exact internal host or host:port entries. |
| `AGENT_CONSOLE_REMOTE_IMAGE_MAX_BYTES` | 10485760 | Maximum fetched image bytes. |
| `AGENT_CONSOLE_REMOTE_IMAGE_TIMEOUT_MS` | 10000 | Fetch deadline in milliseconds. |
| `AGENT_CONSOLE_REMOTE_IMAGE_CACHE_BYTES` | 209715200 | Maximum cache size in bytes. |
| `AGENT_CONSOLE_REMOTE_IMAGE_CACHE_TTL_MS` | 604800000 | Maximum entry age in milliseconds. |
| `AGENT_CONSOLE_REMOTE_IMAGE_GLOBAL_CONCURRENCY` | 16 | Maximum simultaneous remote fetches. |
| `AGENT_CONSOLE_REMOTE_IMAGE_PRINCIPAL_CONCURRENCY` | 4 | Maximum simultaneous fetches per principal. |

Numeric values must be positive integers. Allow-list entries use exact hosts and
optional ports; wildcards and URL schemes are not accepted. An omitted port matches
the default port of the URL's scheme. The allow-list permits eligible private network
addresses, but does not permit loopback or other blocked address classes.

## Device credentials

The edge supports one-time device pairing, independent credential revocation and fixed
30-day authorization. Only main-credential sessions may manage pairings or explicitly
Renew devices. Authenticated devices may read principal-scoped expiry metadata.

`AGENT_CONSOLE_PAIRING_TTL_SECONDS` sets the fixed pairing lifetime from 60 to 600 seconds
(default 300). The existing state database retains pairing and device records across
replacement. No-auth mode and managed tester credentials do not offer pairing.

Pairing requires TLS or an exact HTTPS forwarding signal from an immediate proxy listed
in `AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS` (comma-separated IP literals, empty by default).
The proxy must overwrite `X-Forwarded-Proto` from its actual TLS connection. The existing
insecure-cookie opt-in permits only loopback HTTP development pairing.

See the [device sign-in protocol](../../docs/device-sign-in.md) for the endpoint flow,
recipient confirmation, cookie behavior, metadata call, audit and threat model.

## Speech synthesis v1

Enable synthesis for a speech provider by setting `"synthesis": true` on its
entry in `AGENT_CONSOLE_SPEECH_PROVIDERS`. The configured origin and bearer
token also serve the provider's `POST /v1/syntheses` endpoint.

Send `POST /api/speech/v1/:provider/syntheses` with `Content-Type: application/json`
and a speech-authorized owner or paired device credential. Machine access and
the speech routes' cross-origin checks apply. Synthesis is available on edges
that require authentication.

```json
{"text":"The timer is ready.","format":"pcm_s16le","sample_rate":8000,"channels":1}
```

All four fields are required. Text must contain a non-whitespace character
and fit within 1,000 UTF-16 code units. The JSON body limit is 8,192 bytes.
The edge sends those four fields to the provider. Both the provider and edge
return HTTP 200 with `Content-Type: audio/pcm; rate=8000; channels=1` and raw
signed 16-bit little-endian samples. Audio is mono and has no container header.
Responses are limited to 30 seconds (480,000 bytes). The edge validates the
media type, size and sample alignment before returning audio with
`Cache-Control: no-store`.

`GET /api/speech/providers` includes a `synthesis` object for enabled providers
on authenticated edges.
It exposes `formats: ["pcm_s16le"]`, `sample_rates: [8000]`, `channels: 1`,
`max_text_length: 1000`, `max_duration_seconds: 30` and `max_bytes: 480000`.
Providers without that object offer transcription only.

Synthesis errors use the edge JSON error envelope. Route errors include an
`error.code` as listed below. Ordinary authentication, cross-origin and
request timeout errors use the shared edge responses.

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid-synthesis-request` | Malformed JSON or missing or blank text. |
| 404 | `speech-provider-not-found` | The provider is unknown or outside the principal's machine grants. |
| 404 | `synthesis-not-offered` | The provider is configured for transcription only. |
| 413 | `synthesis-input-too-large` | JSON or text exceeds the input limit. |
| 415 | `unsupported-synthesis-format` | Request media type, encoding, sample rate or channel count is unsupported. |
| 429 | `speech-provider-busy` | The provider is rate limiting. |
| 502 | `speech-provider-rejected` | The provider refused the request. |
| 502 | `invalid-provider-audio` | Provider audio is missing, malformed or over the limit. |
| 503 | `speech-provider-unavailable` | The provider is unreachable, timed out or reported unavailability. |

Provider credentials, headers and error bodies stay on the server.
The edge does not log synthesis text or audio.
