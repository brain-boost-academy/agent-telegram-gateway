import { createHmac, randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Repo } from "../db/repo.ts";

export type ButtonSpec = { label: string; kind: string; payload: unknown };

export const TTL = {
  request: 30 * 24 * 3600_000, // permission/elicitation buttons: must survive restarts; questions never time out (R20)
  menu: 24 * 3600_000, // sessions/mode/agent pickers, arming cancel
} as const;

/** Inline keyboards whose callback_data is a short id backed by the `callbacks` table (R15, ≤ 64 bytes). */
export class Buttons {
  #repo: Repo;
  /** Per-process key: stable ids are not guessable from the payload. */
  #salt = randomBytes(16);

  constructor(repo: Repo) {
    this.#repo = repo;
  }

  /**
   * `stable`: the same (connector, kind, payload) always gets the same id, so a keyboard that is re-rendered
   * (a form after each toggle) reuses its rows instead of inserting new ones.
   */
  async keyboard(connectorId: string, rows: ButtonSpec[][], ttlMs: number, opts: { stable?: boolean } = {}): Promise<InlineKeyboardMarkup> {
    const db: Parameters<Repo["insertCallbacks"]>[0] = [];
    const inline_keyboard = rows.map((row) =>
      row.map((b) => {
        const short_id = opts.stable
          ? createHmac("sha256", this.#salt).update(`${connectorId}|${b.kind}|${JSON.stringify(b.payload)}`).digest("base64url").slice(0, 16)
          : randomBytes(12).toString("base64url");
        db.push({ short_id, connector_id: connectorId, kind: b.kind, payload: b.payload, ttlMs });
        return { text: b.label, callback_data: short_id };
      }),
    );
    await this.#repo.insertCallbacks(db);
    return { inline_keyboard };
  }
}
