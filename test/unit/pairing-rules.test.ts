// protects=pairing rules of Flow 1 / R3b / D11 and the 128-bit one-time code format;
// fails_when=used/expired/unknown codes pair anyway, re-pair of an owned connector skips owner approval,
//   a user owning another connector is moved without «Перепривязать?», code has <128 bits or is not /start-safe;
// no_claim=DB atomicity of code consumption (covered by the integration test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32, decideStart, newPairingCode } from "../../src/telegram/pairing.ts";
import { T } from "../../src/telegram/texts.ts";

const ok = { status: "ok" as const, connectorId: "c1" };
const connector = { revoked_at: null };
const pairing = (connector_id: string, tg_user_id: number) => ({ connector_id, tg_user_id, tg_chat_id: tg_user_id, user_display: "@x", created_at: new Date() });

test("code: 128 bits, base32 lowercase, Telegram start-param safe", () => {
  const code = newPairingCode();
  assert.match(code, /^[a-z2-7]{26}$/);
  assert.notEqual(code, newPairingCode());
  assert.equal(base32(Buffer.from("foobar")), "mzxw6ytboi");
});

test("bad codes", () => {
  assert.deepEqual(decideStart({ check: { status: "used", connectorId: "c1" }, userId: 1 }), { do: "reply", text: T.codeUsed });
  assert.deepEqual(decideStart({ check: { status: "expired", connectorId: "c1" }, userId: 1 }), { do: "reply", text: T.codeExpired });
  assert.deepEqual(decideStart({ check: { status: "unknown" }, userId: 1 }), { do: "reply", text: T.codeUnknown });
  assert.deepEqual(decideStart({ check: ok, connector: { revoked_at: new Date() }, userId: 1 }), { do: "reply", text: T.connectorRevoked });
});

test("fresh connector, fresh user → pair", () => {
  assert.deepEqual(decideStart({ check: ok, connector, userId: 1 }), { do: "apply" });
});

test("same owner again → nothing to do", () => {
  assert.deepEqual(decideStart({ check: ok, connector, owner: pairing("c1", 1), userId: 1 }), { do: "already" });
});

test("connector owned by someone else → current owner must approve (R3b)", () => {
  const d = decideStart({ check: ok, connector, owner: pairing("c1", 2), userId: 1 });
  assert.equal(d.do, "ask_owner");
});

test("user paired to another connector → «Перепривязать?» first, then owner approval if needed", () => {
  assert.deepEqual(decideStart({ check: ok, connector, userPairing: pairing("c9", 1), userId: 1 }), { do: "confirm_rebind", oldConnectorId: "c9" });
  assert.deepEqual(decideStart({ check: ok, connector, userPairing: pairing("c9", 1), userId: 1, rebindConfirmed: true }), { do: "apply" });
  assert.equal(decideStart({ check: ok, connector, owner: pairing("c1", 2), userPairing: pairing("c9", 1), userId: 1, rebindConfirmed: true }).do, "ask_owner");
});
