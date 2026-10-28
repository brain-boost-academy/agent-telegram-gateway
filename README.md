# agent-telegram-gateway

Telegram side of the agent remote-access system. `agent-connector` daemons (next to Claude Code / opencode) dial
`wss://<gateway>/v1/connect` with a per-connector token; this gateway pairs each connector with exactly one Telegram
account and turns protocol v1 messages into chat UX (streamed answers, live status, permission buttons, agent
questions, voice, files). Protocol: `@brain-boost-academy/agent-protocol` (`packages/protocol` in
agent-websocket-connector, see its `PROTOCOL.md`).

## Layout

```
src/main.ts            process entry (migrate → health → WS + Telegram polling)
src/app.ts             composition, /healthz /readyz, hourly cleanup, admin NOTIFY listener
src/gateway.ts         shared state per connector (agents, session.state, pending requests), pairing cache
src/ws/                server (/v1/connect, auth, hello/welcome, ping), link (Peer + BlobReceiver), registry (one live
                       socket, 4409), replace-alert (R19), events (connector → Telegram, durable dedupe, sync), tokens
src/telegram/          bot (grammY + auto-retry + throttler, TG_PROXY), handlers, commands, inbound (prompt), media
                       (voice/albums/files), render (streaming answer + status), markdown (→ TG HTML, split 4096),
                       status, permissions, elicitation (forms + arming), interactions, pairing, buttons (callbacks)
src/asr/client.ts      giga-runner client
src/db/                migrations/*.sql, own runner (schema_migrations), repo
src/admin/             CLI
```

## Environment

| var | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | bot token |
| `TG_PROXY` | — | proxy for Bot API calls and file downloads, same value the other bots get (flux `proxy-config` `HTTP_PROXY`, e.g. `http://xray-http.xray.svc.cluster.local:1081`); `http(s)://` = CONNECT tunnel, `socks5://` also accepted |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | local Bot API server |
| `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` | — | Postgres (read by the client) |
| `ASR_BASE_URL` | — (voice off) | giga-runner, OpenAI style with `/v1` (`http://giga-runner:8000/v1`); a base without `/vN` gets `/v1` appended |
| `ASR_API_KEY` | — | Bearer for giga-runner |
| `WS_PORT` | 8080 | connector WebSocket (`/v1/connect`) |
| `HTTP_HEALTH_PORT` | 8081 | `/healthz` (process), `/readyz` (DB + `getMe`, cached 30 s) |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `GATEWAY_LABEL` | Telegram | shown to connectors in `welcome` |
| `DISPLAY_TZ` | Europe/Moscow | time zone of times in `/sessions` (addition to the spec env list) |

Behind an ingress the client IP for logs / R19 is the right-most `X-Forwarded-For` entry.

## Admin CLI

```
npm run admin -- connectors create <name>        # prints a 256-bit base64url token ONCE; only sha256 is stored
npm run admin -- connectors list
npm run admin -- connectors revoke <name>        # live socket closed with 4401
npm run admin -- connectors unpair <name>        # drops the pairing, kills unused codes; connector gets pairing.changed{admin_unpair}
npm run admin -- connectors rotate-token <name>  # new token, old one stops working, live socket closed (4401)
npm run admin -- pairings find --tg <@username|id>
```
In the image: `docker run --env-file … <image> node dist/admin/main.js connectors create af03`.
The CLI talks only to Postgres; the running gateway reacts to revoke/rotate/unpair via `NOTIFY gateway_admin`.

## Dev run

```
docker compose up -d postgres               # postgres:17 on localhost:5432 (gateway/gateway)
cp .env.example .env                        # set TELEGRAM_BOT_TOKEN (+ TG_PROXY, ASR_*)
npm install
npm run dev                                 # node src/main.ts, migrations run on start
npm run admin -- connectors create dev      # token for the connector config
```
Full stack in containers: `docker compose up --build` (postgres + gateway; the image build needs the release-URL protocol dependency, see below).

## Tests

```
npm run typecheck
npm test                 # starts the compose postgres if nothing answers on PG*/localhost:5432, then node --test
npm run test:unit        # no database needed
```
Integration tests create a throw-away database per file, run the gateway in-process with grammY's Bot API
intercepted by a transformer (`test/helpers/harness.ts`, nothing reaches Telegram), feed updates with
`bot.handleUpdate`, and drive it with a fake connector built on the protocol package (`Peer`, `BlobReceiver`).
Every test file starts with a `protects=…; fails_when=…; no_claim=…` card.

## E2E

`docs/e2e-checklist.md`: full chain with a fake Bot API (`scripts/e2e/`), the real connector and claude-agent-acp, plus the results of the last run.

## Known limitations

- After a gateway restart mid-turn the answer continues in a new message; the partial answer and the old status message of the dead process stay as they were (render state is not persisted, R2/R15).
- Owner approvals and the «Перепривязать?» question live in memory; after a restart their buttons answer «Запрос устарел».

## Protocol dependency (D13)

During development `package.json` points at the sibling checkout:
`"@brain-boost-academy/agent-protocol": "file:../agent-websocket-connector/packages/protocol"`.
The Dockerfile and CI assume the final state. Once `protocol-vX.Y.Z` is released (and the connector repo is public, R18),
switch with one command and commit both files:

```
npm install https://github.com/brain-boost-academy/agent-websocket-connector/releases/download/protocol-v1.0.0/brain-boost-academy-agent-protocol-1.0.0.tgz
```
Until then `npm ci` in CI/Docker cannot resolve the `file:` path (it is outside the build context).

## CI

- `.github/workflows/ci.yml` — push to main / PR: `npm ci`, typecheck, test with a postgres:17 service.
- `.github/workflows/image.yml` — tag `vX.Y.Z`: the same tests, then build and push `ghcr.io/<repo>:<version>` and `:sha-…`.

## M0 spikes owned by the gateway

- **(d) ogg/opus voice through giga-runner — works.** A 6.4 s Russian sample encoded like a Telegram voice note
  (`ffmpeg -ac 1 -ar 48000 -c:a libopus -b:a 32k -application voip`, OGG/Opus 48 kHz mono, named `voice.oga`)
  posted by `AsrClient` to `http://localhost:8000/v1/audio/transcriptions` returned the correct text in 0.8 s (warm).
- **(e) `sendMessageDraft`** exists in grammY 1.46 (`@grammyjs/types` 5.0.0, `ctx.replyWithDraft`): private chats only,
  the draft is an ephemeral ~30 s preview, disappears when the bot sends any other message, and the final text must
  still be sent with `sendMessage`. Our turns interleave other messages (status edits, verbose tool messages,
  permission/question prompts) and need a real message id for `message_sessions` (reply → session), and it could not be
  verified against real Telegram here. Answer streaming therefore uses edit-in-place, at most one flush per second per turn.

## What the connector must do for this UX

- `conversation_id` is `String(tg_chat_id)` (private chat = user id); it is in `welcome.pairing.conversation_id` and
  every `pairing.changed{paired:true}`. Messages for other conversation ids are not shown (durable ones are acked).
- Send `sync` after every `welcome` (running turns with `text_so_far`, `steps`, `current_tool`, `started_at`; all pending
  permission/elicitation requests). Pending requests missing from `sync` are treated as closed (old buttons answer
  «Запрос уже закрыт»).
- Send `session.state` for the owner conversation after any binding/mode/busy change and include it in `sync.conversations`;
  `/mode` buttons come only from the latest `modes`; `current_mode_update` updates the current mode.
- Every `session.update` of a turn carries `turn_id`; `turn.started` before the first update (otherwise the status is
  drawn lazily on the first update). Text arrives as `agent_message_chunk` with `content.type = "text"`. Tool calls as
  `tool_call` (+ `tool_call_update`), each new `toolCallId` = one step. Cost from `usage_update.cost {amount, currency:"USD"}`
  or `turn.ended.cost_usd`.
- `turn.ended.text` = the full agent text; the gateway replaces its own text with it when it has more non-whitespace
  characters (missed chunks). Join text segments around tool calls with blank lines (the gateway inserts `\n\n` itself
  between chunks separated by a tool call).
- Durable messages are acked with `delivered {id: durableKey()}` only after Telegram accepted them; resend until acked.
  `notify` blobs must be re-sent before every resend; a `notify` referencing an unknown blob gets `error invalid_message`.
  Durable messages while unpaired get `error not_paired` (drop the `notify`, R16).
- Inbound files: the gateway uploads each file with `sendBufferBlob` (≤ 20 MB) and waits for `blob.stored`, then sends one
  `conversation.prompt {attachments:[blob_id…], text: caption}` per message/album.
- Elicitation answers: `{action:"accept", content:{<key>: const}}` or `{<key>_custom: text}` for «Свой вариант»;
  multi-select sends an array of consts; «Отмена» sends `{action:"cancel"}`. Form fields are asked in `properties` order.
- `prompt.accepted.queued_position > 0` is shown as «⏳ в очереди: N».
- Requests time out after 30 s on the gateway side (protocol default).
