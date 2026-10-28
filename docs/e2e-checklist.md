# E2E checklist

Full chain without a real bot: `scripts/e2e/fake-bot-api.mjs` (fake Bot API) → gateway (`TELEGRAM_API_ROOT=http://127.0.0.1:18443`) → agent-connector daemon → real claude-agent-acp. `scripts/e2e/tg.mjs` plays the Telegram user (`say`, `click`, `voice`, `doc`, `show`, `wait`).

```sh
FAKE_TG_PORT=18443 node scripts/e2e/fake-bot-api.mjs &
node --env-file=e2e.env src/main.ts &          # TELEGRAM_BOT_TOKEN=1:x TELEGRAM_API_ROOT=http://127.0.0.1:18443 PGDATABASE=gateway_e2e …
node --env-file=e2e.env src/admin/main.ts connectors create e2e   # token → connector token_file
agent-connector daemon &                        # config: gateways[0].url = ws://127.0.0.1:<WS_PORT>/v1/connect
agent-connector pair                            # → t.me/agent_test_bot?start=<code>
node scripts/e2e/tg.mjs say "/start <code>"
```

On real Telegram (staging bot) the same list applies; only the transport differs.

## Run 2026-10-19 (fake Bot API, claude-agent-acp 0.93.0, giga-runner local)

| AC | Scenario | Result |
|---|---|---|
| 2 | `agent-connector pair` → `/start <code>` → `channels` shows paired | ✅ |
| 4 | text → status message + streamed answer, collapses to «✓ N шагов · s · $» | ✅ |
| 5 | voice (ogg/opus) → «🎤 …» via giga-runner → agent answers | ✅ |
| 6 | document + caption → `uploads/<date>/data.csv`, agent answers about it | ✅ |
| 7 | Bash `touch` → [Разрешить]/[Запретить] → file created, message edited to «✅ Разрешено» | ✅ |
| 8 + R6 | AskUserQuestion → option buttons + «✍️ Свой вариант» → typed answer reaches the agent | ✅ |
| 9 | `/stop` mid-stream → «⏹ остановлено» in ~2.3 s | ✅ |
| 10 | `/sessions` → pick an old session → preview of its last answer | ✅ |
| 11 | `claude -p --plugin-dir …` → `send_message` with file → TG; reply → same session (remembers a code word) | ✅ |
| 13 | gateway killed mid-stream → after restart the answer continues in a new message, completes once | ✅ (old partial message and old status stay as they were) |
| 15 | connector stopped → «🔌 агент не в сети» | ✅ |
| R3b | `admin connectors unpair` → owner notified, connector `channels` shows not paired | ✅ |
| — | reply to an agent answer after `after_turn` close → session reloaded with context | ✅ |

Found and fixed during the run: background Bash (`run_in_background`) was killed by the after-turn close → connector now holds such sessions for `busy_hold_minutes`.

Not covered here: AC3/12/14/16/17 (covered by integration tests and `npm run test:adapters` in the connector), real Telegram HTML acceptance and rate limits, real `TG_PROXY`.

**AC18 is not covered by anything yet.** AC18 = scenarios 4, 7, 9, 10 with `opencode acp` (`/agent opencode`). The connector's opt-in `test/adapters/opencode.test.ts` (skipped when opencode is not installed) covers initialize caps, one turn, session reload and `session/list`; its own card says it makes no claim about permissions (opencode's default config allows tools). opencode's permission requests (AC7) and `/stop` mid-stream (AC9) have never been run, here or in CI. The gateway side is agent-neutral (integration tests use a fake connector), so what is unverified is opencode's ACP behaviour behind the connector. Manual run to close it:

```
// protects=AC18: with `/agent opencode` a text prompt streams and collapses (4), a tool needing approval shows
//   [Разрешить]/[Запретить] and the click reaches opencode (7), /stop mid-stream ends with «⏹ остановлено» (9),
//   /sessions lists opencode sessions and attaching one shows its last answer (10);
// fails_when=opencode permission options do not map to buttons or the chosen optionId is ignored, /stop leaves the turn
//   running or the status stuck at «Работаю», opencode sessions are missing from /sessions or attach fails;
// no_claim=opencode versions other than the one recorded with the run, real Telegram (fake Bot API transport)
```

Steps: `say "/agent opencode"` → `say "создай файл ac18.txt"` (expect the permission buttons, `click` «Разрешить», check the file) → `say "посчитай до 200 по одному числу в строке"` then `say "/stop"` within 2 s → `say "/sessions"` and `click` an opencode session. Record the opencode version and the result in a new «Run» table row.
