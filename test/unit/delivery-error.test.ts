// protects=classification of undeliverable durables (protocol 1.2.0): transient → internal (connector retries), permanent → terminal;
// fails_when=a programming error in rendering (TypeError/RangeError/SyntaxError) is reported as `internal` and retried forever,
//   a Telegram 429/5xx is terminal, a blocked bot is retried;
// no_claim=which exceptions the renderer can actually throw
import { test } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { deliveryError } from "../../src/ws/events.ts";

const tg = (code: number, description: string) => new GrammyError("call failed", { ok: false, error_code: code, description }, "sendMessage", {});

test("programming errors are terminal invalid_message, not retried", () => {
  assert.equal(deliveryError(new TypeError("cannot read properties of undefined")).code, "invalid_message");
  assert.equal(deliveryError(new RangeError("invalid array length")).code, "invalid_message");
  assert.equal(deliveryError(new SyntaxError("bad json")).code, "invalid_message");
});

test("transient failures stay internal; Telegram codes map as documented", () => {
  assert.equal(deliveryError(new Error("connection terminated")).code, "internal");
  assert.equal(deliveryError(tg(429, "Too Many Requests")).code, "internal");
  assert.equal(deliveryError(tg(502, "Bad Gateway")).code, "internal");
  assert.equal(deliveryError(tg(403, "Forbidden: bot was blocked by the user")).code, "not_paired");
  assert.equal(deliveryError(tg(400, "Bad Request: chat not found")).code, "not_paired");
  assert.equal(deliveryError(tg(400, "Bad Request: message is too long")).code, "invalid_message");
});
