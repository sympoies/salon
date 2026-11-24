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

If you started with `docker compose -p example`, pass the same project name after
the Compose file in the smoke command.

```bash
bash scripts/smoke-compose.sh compose.yaml example
```

An exported `COMPOSE_PROJECT_NAME` also sets the project for both commands. If you
supply both, the smoke script uses its project argument.

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

Set `apiKeyHelper` in the existing settings file. The command updates that
entry and preserves the activity hooks and other settings in `claude-state`.
If you already use another helper, edit its entry in `settings.json` to switch.

```bash
docker compose exec -T workspace node /opt/salon/docker/claude-api-key-helper.ts add
```

To remove API-key access, close active Claude sessions, remove the helper
setting, and delete the key file from the container.

```bash
docker compose exec -T workspace node /opt/salon/docker/claude-api-key-helper.ts remove && \
  docker compose exec workspace rm -f /home/node/.claude/api-key
```

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
[codex-config]: https://developers.openai.com/codex/config-reference/
[claude-helper]: https://code.claude.com/docs/en/settings-reference#apikeyhelper
[claude-auth]: https://code.claude.com/docs/en/authentication
[claude-trust]: https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust

## Set workspace trust

On startup, Salon adds [Codex trust][codex-config] for the default working
directory, `$HOME/Project/workspace` inside the container. The entry lives in
`$CODEX_HOME/config.toml` on the `provider-state` volume. Restarts keep any
existing trust decision and other settings.

To trust an additional mounted directory for Codex, edit that same file. Use the
absolute path as seen inside the container. If the file already has a project
table for that path, set `trust_level` in the existing table.

```toml
[projects."/mnt/extra"]
trust_level = "trusted"
```

After signing in to Claude Code or setting up its API key, run this command
in the container workspace before creating a browser session.

```bash
docker compose exec -it workspace claude
```

Choose a text style, finish onboarding, and confirm [workspace trust][claude-trust]
after reviewing the folder. Exit Claude and create the session in Salon. The
`claude-state` volume keeps these choices. Repeat setup for the same workspace only
if you recreate that volume.

For a newly mounted directory, add `--workdir` with its absolute container path
before `workspace` in the command and confirm trust there.

### Claude activity hooks

At startup, Salon runs `agent-session activity setup --agent claude --apply`.
The pinned CLI adds hook handlers to `$CLAUDE_CONFIG_DIR/settings.json` in
`claude-state`, preserves unrelated settings and hooks, and skips rewriting a
file that already has the managed handlers. The hooks report activity as Claude
Code runs. Provider sign-in and workspace trust still require the steps above.

The image supplies a digest-pinned policy for Claude activity only. Finish-line
checks require a systemd user manager, cgroup v2 and user namespaces on the host.

If startup logs a hook setup warning, preview the problem from the running
container. The setup command refuses unsafe settings files and requires review
before replacing legacy or drifted hook entries.

```bash
docker compose exec workspace agent-session activity setup --agent claude --dry-run
```

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

Named volumes preserve workspace files, provider login and history, and daemon records.
The edge database at `$XDG_STATE_HOME/salon/access.sqlite` inside the container
preserves Salon browser sessions and the Conversation shared reply outbox in
the `runtime-state` volume across restarts.
Stopping the container ends live tmux processes. Durable session records and provider
history survive; resuming a stopped session remains owned by agent-session.

Browser reload while the container runs must reconnect to the same live session. Container
restart is a separate persistence/resume check. `docker compose down` retains named
volumes; removing volumes destroys this local state.

## Validation and acceptance

Run the [project gate](../DEVELOPMENT.md#validation). It includes the actual workspace
typecheck/build and `node --test docker/start.test.ts`. The startup tests cover readiness,
token separation, durable browser credentials and sessions, Codex workspace trust,
Claude hook setup, failure and shutdown with isolated process fixtures.

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

### Check Codex API-key prompt delivery offline

In a fresh disposable image started with `--network none`, run
`node --test /opt/salon/docker/codex-api-key.test.ts` inside the container.
The test uses synthetic auth and a loopback provider that returns HTTP 503.
It checks the initial prompt and durable Conversation receipt through the real
edge and daemon and confirms Codex reached the loopback endpoint. Real provider
replies are covered by scheduled acceptance.

### Check Claude hooks and shared replies

Run this check in a fresh, disposable Compose workspace.

```bash
docker compose exec -T workspace node --test /opt/salon/docker/container-smoke.test.ts
```

The check runs `agent-hook`, verifies that startup configured the Claude hooks,
and sends a shared outbox request to the real edge for a synthetic session. It
requires no provider credentials. The release workflow runs it against the
published image digest alongside the Compose smoke.

### Complete scheduled provider acceptance

A fixture response, headless UI run or successful daemon inventory request cannot
establish real-provider acceptance. The scheduled tester must complete official login,
session creation, one real prompt/reply and browser reload.

Record the exact source head, commands and remaining limits before handoff. No image,
source archive or release is published by this developer flow.

### Installed runtime and licenses

The pinned CLI runtime includes agent-session and agent-hook from nils-cli
1.42.6, along with Codex 0.162.1. The image keeps the
released nils-cli license/notices under `/opt/nils` and the Codex license/notice under
`/usr/local/share/licenses/codex`. The two nils-cli binaries come from the same
digest-checked release archive.
