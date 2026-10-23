# Salon

Salon is a self-hostable, container-first chat workspace for working with
coding agents from a browser: start a session, talk to it, and reconnect to the
same session later.

## Status

Salon is being bootstrapped. This repository currently contains contributor
documentation and scaffold validation. The first usable application milestone
is still pending; there is no runnable application or container setup yet.

The first developer milestone will support one provider. The full MVP will
support two providers. The intended user flow for those milestones is:

1. Start the workspace with `docker compose up --build`.
2. Complete official provider login or API-key setup.
3. Create a session and send a prompt.
4. Receive an actual provider reply.
5. Refresh the browser or reconnect to the same session.

These are planned acceptance steps, not commands that work in this scaffold.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites and validation, and
[AGENTS.md](AGENTS.md) for contributor instructions. Durable implementation
context is recorded in the [development log](docs/devlog/README.md).

## License

[MIT](LICENSE), copyright Salon contributors.
