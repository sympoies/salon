# Container development

This developer flow targets a single non-root container with the shared, edge
and UI packages, agent-session, tmux and the official Codex CLI. Only Codex is
installed for this milestone. The shared UI retains its existing provider
choices; select Codex. Provider login and credentials remain owned by Codex.

## Validation status

The isolated application and container build, authenticated HTTP and emergency
shell transport, browser login/reload and volume persistence checks have passed.
Official provider login, a real provider session, prompt/reply and conversation
reconnect still require scheduled acceptance. These checks use the canonical
core packages; the application does not implement its own session lifecycle.

## Start and authenticate

Start from a clean checkout:

```bash
docker compose up --build -d
docker compose ps
```

Open `http://127.0.0.1:3000`. The browser requires its own Salon login token;
read that token locally:

```bash
docker compose exec workspace cat /home/node/.local/state/salon/browser-token
```

Keep this browser credential private.
The daemon token is distinct and remains server-side. The browser uses the
core's authenticated cookie, write and WebSocket attachment paths. Raw daemon
ports are never published.

Complete official provider setup inside the running container:

```bash
docker compose exec workspace codex login --device-auth
docker compose exec workspace codex login status
```

Device login may need account or workspace enablement. Follow the printed
provider instructions. An operator who chooses API-key authentication supplies
the key privately through stdin to `codex login --with-api-key`, using the
[official authentication documentation](https://developers.openai.com/codex/auth).
Do not add keys to Compose, build arguments, command arguments, shell history
or repository files. No host authentication cache is imported.

The image installs a pinned official `@openai/codex` npm package, a method
covered by the [official CLI installation guide](https://developers.openai.com/codex/cli).
The CLI package declares Apache-2.0 licensing; retain its bundled license and
notices. Provider service access remains subject to its account terms.

## Create and reconnect

In the browser, choose Codex and create a session. The default working directory
is the persisted workspace. The directory picker discovers Git repositories
under the container's `HOME/Project`; initialize or clone a repository into the
workspace volume to make it discoverable. Send a prompt and wait for the actual
provider reply. Reload and select the same session to verify conversation
continuity. A new browser login may require the same Salon token.

```bash
docker compose stop
docker compose up -d
```

Named volumes preserve workspace files, provider login/history and daemon
records. Stopping the container ends live tmux processes. Durable session
records and provider history survive; resuming a stopped session remains owned
by agent-session. Browser reload while the container runs must reconnect to the
same live session. Container restart is a separate persistence/resume check.
`docker compose down` retains named volumes; removing volumes destroys this
local state.

## Validation and acceptance

Run the [project gate](../DEVELOPMENT.md#validation). It includes the actual
workspace typecheck/build and `node --test docker/start.test.ts`. The startup
tests cover readiness, token separation, durable browser credentials, failure
and shutdown with isolated process fixtures. They do not contact a provider.
On Linux, use the documented memory scope for build/test commands; give an
isolated BuildKit builder the same six-GiB memory and zero-swap budget because
the client scope alone does not constrain a Docker daemon's build workers.

Check non-root execution, authenticated assets/session writes/attach, refusal
without browser authentication, token separation and state persistence.
The isolated smoke exercised real tmux input/output and socket reconnect through
the core's authenticated emergency-shell route without starting a provider.
Container recreation preserved all three volumes and the browser login token;
the expired browser cookie required login again, and the stopped shell was not
silently recreated. Headless Chrome rendered login and the Codex session dialog
and retained authenticated access after reload at desktop and mobile sizes.

A fixture response, headless UI run or successful daemon inventory request
cannot establish real-provider acceptance. The scheduled tester must complete
official login, session creation, one real prompt/reply and browser reload.
Record the exact source head, commands and remaining limits before handoff.
No image, source archive or release is published by this developer flow.

The pinned CLI runtime is agent-session 1.36.26 and Codex 0.162.1. The
image keeps the released nils-cli license/notices under `/opt/nils` and the
Codex license/notice under `/usr/local/share/licenses/codex`. Only the
agent-session binary is installed from nils-cli; no private runtime or hooks
are copied from the host.
