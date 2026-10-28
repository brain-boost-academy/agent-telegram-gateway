import { randomUUID } from "node:crypto";
import type { Sql } from "./sql.ts";

export type SessionRef = { agent_id: string; session_id: string; cwd: string };

export type ConnectorRow = {
  id: string;
  name: string;
  created_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
};

export type PairingRow = {
  connector_id: string;
  tg_user_id: number;
  tg_chat_id: number;
  user_display: string;
  created_at: Date;
};

export type CallbackRow = { short_id: string; connector_id: string; kind: string; payload: unknown; expires_at: Date };

export type CodeCheck =
  | { status: "ok"; connectorId: string }
  | { status: "unknown" }
  | { status: "used"; connectorId: string }
  | { status: "expired"; connectorId: string };

/** All SQL lives here. Functions are thin and side-effect only on the database. */
export class Repo {
  readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  // ---- connectors ----

  async createConnector(name: string, tokenSha256: Buffer): Promise<ConnectorRow> {
    const [row] = await this.sql<ConnectorRow[]>`
      insert into connectors (id, name, token_sha256) values (${randomUUID()}, ${name}, ${tokenSha256})
      returning id, name, created_at, revoked_at, last_seen_at`;
    return row!;
  }

  async connectorByTokenHash(tokenSha256: Buffer): Promise<ConnectorRow | undefined> {
    const [row] = await this.sql<ConnectorRow[]>`
      select id, name, created_at, revoked_at, last_seen_at from connectors where token_sha256 = ${tokenSha256}`;
    return row;
  }

  async connectorById(id: string): Promise<ConnectorRow | undefined> {
    const [row] = await this.sql<ConnectorRow[]>`select id, name, created_at, revoked_at, last_seen_at from connectors where id = ${id}`;
    return row;
  }

  async connectorByName(name: string): Promise<ConnectorRow | undefined> {
    const [row] = await this.sql<ConnectorRow[]>`select id, name, created_at, revoked_at, last_seen_at from connectors where name = ${name}`;
    return row;
  }

  async listConnectors(): Promise<Array<ConnectorRow & { user_display: string | null; tg_user_id: number | null }>> {
    return this.sql`
      select c.id, c.name, c.created_at, c.revoked_at, c.last_seen_at, p.user_display, p.tg_user_id
      from connectors c left join pairings p on p.connector_id = c.id order by c.name`;
  }

  async revokeConnector(name: string): Promise<ConnectorRow | undefined> {
    const [row] = await this.sql<ConnectorRow[]>`
      update connectors set revoked_at = coalesce(revoked_at, now()) where name = ${name}
      returning id, name, created_at, revoked_at, last_seen_at`;
    return row;
  }

  /** New token replaces the old one (old stops working immediately); clears a revocation. */
  async rotateToken(name: string, tokenSha256: Buffer): Promise<ConnectorRow | undefined> {
    const [row] = await this.sql<ConnectorRow[]>`
      update connectors set token_sha256 = ${tokenSha256}, revoked_at = null where name = ${name}
      returning id, name, created_at, revoked_at, last_seen_at`;
    return row;
  }

  /**
   * Heartbeat + authorization re-check: false when the token was revoked or rotated since the link authenticated
   * (the admin NOTIFY may have been lost).
   */
  async touchLastSeen(id: string, tokenSha256: Buffer): Promise<boolean> {
    const rows = await this.sql`
      update connectors set last_seen_at = now()
      where id = ${id} and token_sha256 = ${tokenSha256} and revoked_at is null
      returning id`;
    return rows.length > 0;
  }

  // ---- pairings ----

  async pairingByConnector(connectorId: string): Promise<PairingRow | undefined> {
    const [row] = await this.sql<PairingRow[]>`select * from pairings where connector_id = ${connectorId}`;
    return row;
  }

  async pairingByUser(tgUserId: number): Promise<PairingRow | undefined> {
    const [row] = await this.sql<PairingRow[]>`select * from pairings where tg_user_id = ${tgUserId}`;
    return row;
  }

  /**
   * Strict 1:1 (D11): removes any pairing of the connector and of the user, then inserts the new one.
   * Returns the removed rows so the caller can notify the losers.
   */
  async setPairing(p: Omit<PairingRow, "created_at">): Promise<PairingRow[]> {
    return this.sql.begin(async (tx) => {
      const removed = await tx<PairingRow[]>`
        delete from pairings where connector_id = ${p.connector_id} or tg_user_id = ${p.tg_user_id} returning *`;
      await tx`insert into pairings (connector_id, tg_user_id, tg_chat_id, user_display)
               values (${p.connector_id}, ${p.tg_user_id}, ${p.tg_chat_id}, ${p.user_display})`;
      return removed;
    });
  }

  async deletePairing(connectorId: string): Promise<PairingRow | undefined> {
    const [row] = await this.sql<PairingRow[]>`delete from pairings where connector_id = ${connectorId} returning *`;
    return row;
  }

  /** `query` is a numeric tg id or `@username` (matched against user_display). */
  async findPairings(query: string): Promise<Array<PairingRow & { name: string }>> {
    const q = query.trim();
    if (/^-?\d+$/.test(q)) {
      return this.sql`select p.*, c.name from pairings p join connectors c on c.id = p.connector_id
                      where p.tg_user_id = ${Number(q)} or p.tg_chat_id = ${Number(q)}`;
    }
    const name = q.startsWith("@") ? q : `@${q}`;
    return this.sql`select p.*, c.name from pairings p join connectors c on c.id = p.connector_id
                    where lower(p.user_display) = lower(${name})`;
  }

  // ---- pairing codes ----

  async insertCode(code: string, connectorId: string, expiresAt: Date): Promise<void> {
    await this.sql`insert into pairing_codes (code, connector_id, expires_at) values (${code}, ${connectorId}, ${expiresAt})`;
  }

  /** One-time use: marks the code used atomically when it is valid. */
  async consumeCode(code: string, now = new Date()): Promise<CodeCheck> {
    const [used] = await this.sql<{ connector_id: string }[]>`
      update pairing_codes set used_at = ${now}
      where code = ${code} and used_at is null and expires_at > ${now}
      returning connector_id`;
    if (used) return { status: "ok", connectorId: used.connector_id };
    const [row] = await this.sql<{ connector_id: string; used_at: Date | null }[]>`
      select connector_id, used_at from pairing_codes where code = ${code}`;
    if (!row) return { status: "unknown" };
    return row.used_at ? { status: "used", connectorId: row.connector_id } : { status: "expired", connectorId: row.connector_id };
  }

  /** Invalidates all unused codes of a connector (admin unpair). */
  async killCodes(connectorId: string): Promise<void> {
    await this.sql`update pairing_codes set used_at = now() where connector_id = ${connectorId} and used_at is null`;
  }

  // ---- message → session ----

  async recordMessageSession(chatId: number, messageId: number, connectorId: string, s: SessionRef): Promise<void> {
    await this.sql`
      insert into message_sessions (tg_chat_id, tg_message_id, connector_id, agent_id, session_id, cwd)
      values (${chatId}, ${messageId}, ${connectorId}, ${s.agent_id}, ${s.session_id}, ${s.cwd})
      on conflict (tg_chat_id, tg_message_id) do nothing`;
  }

  async messageSession(chatId: number, messageId: number): Promise<(SessionRef & { connector_id: string }) | undefined> {
    const [row] = await this.sql<(SessionRef & { connector_id: string })[]>`
      select connector_id, agent_id, session_id, cwd from message_sessions
      where tg_chat_id = ${chatId} and tg_message_id = ${messageId}`;
    return row;
  }

  // ---- chat settings ----

  async verbose(chatId: number): Promise<boolean> {
    const [row] = await this.sql<{ verbose: boolean }[]>`select "verbose" from chat_settings where tg_chat_id = ${chatId}`;
    return row?.verbose ?? false;
  }

  async setVerbose(chatId: number, verbose: boolean): Promise<void> {
    await this.sql`insert into chat_settings (tg_chat_id, "verbose") values (${chatId}, ${verbose})
                   on conflict (tg_chat_id) do update set "verbose" = excluded."verbose"`;
  }

  // ---- callbacks (R15) ----

  async insertCallbacks(rows: Array<Omit<CallbackRow, "expires_at"> & { ttlMs: number }>): Promise<void> {
    if (!rows.length) return;
    const now = Date.now();
    const values = rows.map((r) => ({
      short_id: r.short_id,
      connector_id: r.connector_id,
      kind: r.kind,
      payload: this.sql.json(r.payload as never),
      expires_at: new Date(now + r.ttlMs),
    }));
    // Stable ids (re-rendered forms) map to the same payload, so an existing row is kept as is.
    await this.sql`insert into callbacks ${this.sql(values, "short_id", "connector_id", "kind", "payload", "expires_at")} on conflict (short_id) do nothing`;
  }

  async callback(shortId: string): Promise<CallbackRow | undefined> {
    const [row] = await this.sql<CallbackRow[]>`
      select short_id, connector_id, kind, payload, expires_at from callbacks where short_id = ${shortId} and expires_at > now()`;
    return row;
  }

  // ---- delivered (R2/R9) ----

  async isDelivered(connectorId: string, key: string): Promise<boolean> {
    const rows = await this.sql`select 1 from delivered where connector_id = ${connectorId} and msg_id = ${key}`;
    return rows.length > 0;
  }

  async markDelivered(connectorId: string, key: string): Promise<void> {
    await this.sql`insert into delivered (connector_id, msg_id) values (${connectorId}, ${key}) on conflict do nothing`;
  }

  // ---- housekeeping ----

  async cleanup(): Promise<{ pairing_codes: number; message_sessions: number; delivered: number; callbacks: number }> {
    const codes = await this.sql`delete from pairing_codes where expires_at < now() - interval '1 day'`;
    const ms = await this.sql`delete from message_sessions where created_at < now() - interval '30 days'`;
    const del = await this.sql`delete from delivered where created_at < now() - interval '7 days'`;
    const cb = await this.sql`delete from callbacks where expires_at < now()`;
    return { pairing_codes: codes.count, message_sessions: ms.count, delivered: del.count, callbacks: cb.count };
  }
}
