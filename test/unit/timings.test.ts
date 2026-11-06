// protects=spec timings (R3b): owner approval / re-pair confirmation and pairing codes live 10 minutes; edits ≤ 1/s; pairing cache 60 s;
//   messages of one chat within 1 s become one prompt, sent at most 5 s after the first; shutdown waits ≤ 4 s for them;
// fails_when=someone shortens/extends these defaults (tests override them, so integration tests would not notice);
// no_claim=that the timers fire on time (integration tests with short overrides)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMINGS } from "../../src/gateway.ts";

test("default timings", () => {
  assert.equal(DEFAULT_TIMINGS.approvalMs, 10 * 60_000);
  assert.equal(DEFAULT_TIMINGS.codeTtlMs, 10 * 60_000);
  assert.equal(DEFAULT_TIMINGS.flushMs, 1000);
  assert.equal(DEFAULT_TIMINGS.pairingTtlMs, 60_000);
  assert.equal(DEFAULT_TIMINGS.burstMs, 1000);
  assert.equal(DEFAULT_TIMINGS.burstMaxMs, 5000);
  assert.equal(DEFAULT_TIMINGS.stopFlushMs, 4000);
});
