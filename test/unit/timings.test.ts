// protects=spec timings (R3b): owner approval / re-pair confirmation and pairing codes live 10 minutes; edits ≤ 1/s; pairing cache 60 s;
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
});
