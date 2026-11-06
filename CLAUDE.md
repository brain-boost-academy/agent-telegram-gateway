# CLAUDE.md

## Related project: agent-connector

The connector side of the system (agent-connector daemon and the `@brain-boost-academy/agent-protocol` package in
`packages/protocol`) lives next to this repo: `~/proj/agent-websocket-connector`.

Treat the two repos as one project: a single session may read and change both, e.g. a protocol change touches
`packages/protocol` there, the connector, and the gateway here. Each repo keeps its own git history, versions and
commits.

## Version

The gateway version lives only in `package.json` (+ `package-lock.json`): `src/app.ts` reads `VERSION` from it at
start. Do not hard-code the version anywhere else; a release bumps it with `npm version X.Y.Z --no-git-tag-version`.
