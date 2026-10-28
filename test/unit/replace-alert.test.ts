// protects=R19 alert on token use from several places: ≥3 replacements in 10 min from ≥2 IPs, at most once per hour;
// fails_when=alert fires for a single IP (connector restarts), for <3 replacements, outside the window, or more than once per hour;
// no_claim=delivery of the Telegram warning (integration test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplaceAlert } from "../../src/ws/replace-alert.ts";

const MIN = 60_000;

test("same IP never alerts", () => {
  const r = new ReplaceAlert();
  for (let i = 0; i < 10; i++) assert.equal(r.record("c", "1.1.1.1", "1.1.1.1", i * 1000), null);
});

test("third replacement within 10 min from two IPs alerts once, then hourly cooldown", () => {
  const r = new ReplaceAlert();
  assert.equal(r.record("c", "1.1.1.1", "2.2.2.2", 0), null);
  assert.equal(r.record("c", "2.2.2.2", "1.1.1.1", 1 * MIN), null);
  assert.deepEqual(r.record("c", "1.1.1.1", "2.2.2.2", 2 * MIN), ["1.1.1.1", "2.2.2.2"]);
  assert.equal(r.record("c", "2.2.2.2", "1.1.1.1", 3 * MIN), null);
  assert.equal(r.record("c", "1.1.1.1", "2.2.2.2", 59 * MIN), null);
  // after an hour, with ≥3 recent events again
  r.record("c", "1.1.1.1", "2.2.2.2", 61 * MIN);
  assert.deepEqual(r.record("c", "1.1.1.1", "3.3.3.3", 63 * MIN), ["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
});

test("replacements spread over more than 10 minutes do not alert; connectors are counted separately", () => {
  const r = new ReplaceAlert();
  assert.equal(r.record("c", "1.1.1.1", "2.2.2.2", 0), null);
  assert.equal(r.record("c", "2.2.2.2", "1.1.1.1", 6 * MIN), null);
  assert.equal(r.record("c", "1.1.1.1", "2.2.2.2", 11 * MIN), null);
  assert.equal(r.record("d", "1.1.1.1", "2.2.2.2", 11 * MIN), null);
});
