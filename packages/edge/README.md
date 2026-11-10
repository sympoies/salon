# Edge configuration

Consumers may set `AGENT_CONSOLE_SERVER_VERSION` and `AGENT_CONSOLE_SERVER_BUILD` to
identify the running server in Settings.

Both are optional. Unset or blank values are omitted from the authenticated server-version
response.

## Remote conversation images

The authenticated `GET /api/history/sessions/:machine/:id/remote-image?url=...` route
serves a remote image to a principal allowed to read that history. The URL is the
original URL from the conversation. Cross-origin requests are refused. Successful
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
