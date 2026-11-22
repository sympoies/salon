# Container development

This developer flow targets a single non-root container with the shared, edge and UI
packages, agent-session, tmux and the official Codex and Claude Code CLIs. The default
provider choices are available in **New**. Each CLI handles its own authentication.

## Validation status

The isolated application and container build, authenticated HTTP and emergency shell
transport, browser login/reload and volume persistence checks have passed.

Official provider login, a real provider session, prompt/reply and conversation reconnect
still require scheduled acceptance. These checks use the canonical core packages; the
application does not implement its own session lifecycle.

## Start and authenticate

Start from a clean checkout:

```bash
docker compose up --build -d
docker compose ps
```

To run a published image instead of building, see
[Start from the published image](../README.md#start-from-the-published-image) and add
`-f compose.image.yaml` to every `docker compose` command below.

Open `http://127.0.0.1:3000`. The browser requires its own Salon login token; read that
token locally:

```bash
docker compose exec workspace cat /home/node/.local/state/salon/browser-token
```

Keep this browser credential private. The daemon token is distinct and remains
server-side. The browser uses the core's authenticated cookie, write and WebSocket
attachment paths. Raw daemon ports are never published.

## Set up provider authentication

Choose one mode per provider. Keep credentials in the provider's named volume.
Supply API keys through stdin from a private file or secret manager. Keep keys
out of Compose, environment files, command arguments, shell history and the
workspace. Salon uses a separate browser token.

### Codex API key

Pipe a key from a private file outside the checkout. Replace the example path
with your own or use a secret manager command that writes the key to stdout.

```bash
docker compose exec -T workspace codex login --with-api-key < /path/to/private/codex-api-key
docker compose exec workspace codex login status
```

Codex saves the credential in `provider-state`. To sign out and clear the cached
key, close active Codex sessions and run `docker compose exec workspace codex logout`.
Remove any saved source copy when you retire the key.

### Codex subscription login

Enable device-code login in your ChatGPT account or workspace if required. Follow
the link and code printed by Codex in your browser.

```bash
docker compose exec workspace codex login --device-auth
docker compose exec workspace codex login status
```

To sign out and remove the cached subscription credential from `provider-state`,
close active Codex sessions and run `docker compose exec workspace codex logout`.
See the [Codex authentication guide][codex-auth] for both modes.

### Claude API key

Store the key from stdin in the `claude-state` volume. Claude Code reads it through
its [`apiKeyHelper` setting][claude-helper]. Replace the example path with your
private key file or pipe the output of your secret manager command.

```bash
docker compose exec -T workspace sh -c 'umask 077; cat > "$CLAUDE_CONFIG_DIR/api-key"' \
  < /path/to/private/claude-api-key
```

If you already have a user `settings.json` in `claude-state`, add the `apiKeyHelper`
entry below to that file. For a new setup, create the file with this command:

```bash
docker compose exec -T workspace sh -c 'umask 077; set -C; cat > "$CLAUDE_CONFIG_DIR/settings.json"' <<'JSON'
{
  "apiKeyHelper": "cat /home/node/.claude/api-key"
}
JSON
```

To remove API-key access, close active Claude sessions, remove the
`apiKeyHelper` entry, and delete the credential with
`docker compose exec workspace rm -f /home/node/.claude/api-key`.
Run `docker compose exec workspace claude auth logout` to clear any cached
login too. Remove any saved source copy when you retire the key.

### Claude subscription login

Remove the API-key helper and its key first if you are switching modes. Start
[Claude Code's official sign-in flow][claude-auth] in the running container.
Follow the printed instructions in your browser and choose your Claude
subscription account.

```bash
docker compose exec workspace claude auth login
docker compose exec workspace claude auth status
```

To sign out and remove the cached subscription credential from `claude-state`,
close active Claude sessions and run
`docker compose exec workspace claude auth logout`.

The image keeps the official Claude Code 2.1.330 package's license and
accompanying README under `/usr/local/share/licenses/claude`. The binary is
updated by rebuilding the image.

[codex-auth]: https://developers.openai.com/codex/auth
[claude-helper]: https://code.claude.com/docs/en/settings-reference#apikeyhelper
[claude-auth]: https://code.claude.com/docs/en/authentication

## Create and reconnect

In the browser, open **New**, choose Codex or Claude, and create a session. The
default working directory is the persisted workspace. The directory picker finds
Git repositories under the container's `HOME/Project`. Initialize or clone a
repository into the workspace volume to make it discoverable.

Send a prompt and wait for the actual provider reply. Reload and select the same session
to verify conversation continuity. A new browser login may require the same Salon token.

### Check restart persistence

On SIGTERM or SIGINT, the edge stops accepting connections, closes WebSocket
attachments and checkpoints its SQLite stores before exiting. Shutdown is
bounded to 10 seconds; a second signal or a timeout exits unsuccessfully. Set
the container stop grace period to at least 10 seconds; the supplied Compose
configuration uses 15 seconds.

```bash
docker compose stop
docker compose up -d
```

Named volumes preserve workspace files, provider login/history and daemon records.
Stopping the container ends live tmux processes. Durable session records and provider
history survive; resuming a stopped session remains owned by agent-session.

Browser reload while the container runs must reconnect to the same live session. Container
restart is a separate persistence/resume check. `docker compose down` retains named
volumes; removing volumes destroys this local state.

## Validation and acceptance

Run the [project gate](../DEVELOPMENT.md#validation). It includes the actual workspace
typecheck/build and `node --test docker/start.test.ts`. The startup tests cover readiness,
token separation, durable browser credentials, failure and shutdown with isolated process
fixtures. They do not contact a provider.

On Linux, use the documented memory scope for build/test commands; give an isolated
BuildKit builder the same six-GiB memory and zero-swap budget because the client scope
alone does not constrain a Docker daemon's build workers.

Check non-root execution, authenticated assets/session writes/attach, refusal without
browser authentication, token separation and state persistence.

### Recorded isolated checks

The isolated smoke exercised real tmux input/output and socket reconnect through the
core's authenticated emergency-shell route without starting a provider.

Container recreation preserved the original state volumes and browser login token. The expired
browser cookie required login again, and the stopped shell was not silently recreated.

Headless Chrome rendered login and the Codex session dialog and retained authenticated
access after reload at desktop and mobile sizes.

### Check default Codex startup

Run this test in a fresh, locally built Compose workspace before authenticating Codex:

```bash
docker compose exec -T workspace node --test /opt/salon/docker/default-create.test.ts
```

The test checks the process listing Codex uses to register its app-server.
It signs in to Salon and verifies that the default session reaches the Codex sign-in prompt.

### Complete scheduled provider acceptance

A fixture response, headless UI run or successful daemon inventory request cannot
establish real-provider acceptance. The scheduled tester must complete official login,
session creation, one real prompt/reply and browser reload.

Record the exact source head, commands and remaining limits before handoff. No image,
source archive or release is published by this developer flow.

### Installed runtime and licenses

The pinned CLI runtime is agent-session 1.42.1 and Codex 0.162.1. The image keeps the
released nils-cli license/notices under `/opt/nils` and the Codex license/notice under
`/usr/local/share/licenses/codex`. Only the agent-session binary is installed from
nils-cli; no private runtime or hooks are copied from the host.
