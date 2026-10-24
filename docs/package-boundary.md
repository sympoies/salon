# Core package boundary

The reusable core consists of `@agent-console/shared`, `@agent-console/edge` and
`@agent-console/ui`. Existing names and package version `0.1.2` remain in this
private preparation phase. This repository does not contain a downstream
distribution's private composition, configuration or native packaging.

## Import rules

- Shared contracts import no other workspace package.
- Edge and UI may import shared contracts through explicit exported subpaths.
- Core relative imports stay within their package. Edge and UI do not import
  one another or a downstream distribution.
- Consumers use explicit package exports; they do not reach into source paths.

`pnpm check:core` checks these rules and runs a strict generic privacy scan over
source, tests, assets and emitted package files. The scan rejects credential
shapes, personal home paths and non-example email addresses. There is no
baseline or private vocabulary in this repository. A zero finding result is a
bounded automated check, alongside review of the source allowlist and licenses.

## Development and package consumption

Workspace TypeScript tests select the `source` condition. Normal package
resolution selects compiled ESM JavaScript; TypeScript consumers select emitted
declarations. Node 24 cannot strip TypeScript inside `node_modules`, so source
exports are insufficient for installed consumers.

`pnpm build:packages` cleans and compiles all three packages in dependency order.
Each package includes `dist-package/` only, with declarations, the MIT license
and necessary runtime assets. UI assets preserve relative CSS and font paths;
font notices remain with the font assets. Package exports are explicit, with no
wildcard exposing every internal module.

The edge exports a start function accepting an environment and optional generic
extensions. A distribution owns its entry and passes those extensions. The UI
exports its mount function, extension contracts, selected reusable components
and Vite configuration. A distribution owns its page and mounts its extensions.

See [package consumption](package-consumption.md) for the local producer and
isolated installed-package check.
