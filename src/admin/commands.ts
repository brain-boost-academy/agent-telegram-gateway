import type { Repo } from "../db/repo.ts";
import { ADMIN_CHANNEL, type AdminEvent } from "../app.ts";
import { generateToken, hashToken } from "../ws/tokens.ts";

export const USAGE = `usage:
  connectors create <name>        create a connector, print its token once
  connectors list                 list connectors with pairing and last seen
  connectors revoke <name>        revoke the token, close the live connection (4401)
  connectors unpair <name>        drop the Telegram pairing and pending codes
  connectors rotate-token <name>  issue a new token, the old one stops working
  pairings find --tg <@username|id>`;

export class UsageError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function notify(repo: Repo, ev: AdminEvent): Promise<void> {
  await repo.sql`select pg_notify(${ADMIN_CHANNEL}, ${JSON.stringify(ev)})`;
}

/** Admin CLI. Returns lines to print; throws UsageError on bad input. */
export async function runAdmin(argv: string[], repo: Repo): Promise<string[]> {
  const [group, cmd, ...rest] = argv;
  if (group === "connectors") {
    const name = rest[0];
    const need = () => {
      if (!name) throw new UsageError(`connectors ${cmd}: <name> required`);
      return name;
    };
    switch (cmd) {
      case "create": {
        const n = need();
        if (!NAME.test(n)) throw new UsageError("name: letters, digits, . _ - (max 64)");
        if (await repo.connectorByName(n)) throw new UsageError(`connector ${n} already exists`);
        const token = generateToken();
        const c = await repo.createConnector(n, hashToken(token));
        return [`connector ${c.name} created (id ${c.id})`, `token (shown once): ${token}`];
      }
      case "list": {
        const rows = await repo.listConnectors();
        if (!rows.length) return ["no connectors"];
        return rows.map((r) =>
          [
            r.name,
            r.revoked_at ? "REVOKED" : "active",
            r.user_display ? `paired ${r.user_display} (${r.tg_user_id})` : "unpaired",
            `last seen ${r.last_seen_at ? r.last_seen_at.toISOString() : "never"}`,
          ].join("\t"),
        );
      }
      case "revoke": {
        const c = await repo.revokeConnector(need());
        if (!c) throw new UsageError(`no connector ${name}`);
        await notify(repo, { action: "revoke", connector_id: c.id });
        return [`connector ${c.name} revoked`];
      }
      case "rotate-token": {
        const token = generateToken();
        const c = await repo.rotateToken(need(), hashToken(token));
        if (!c) throw new UsageError(`no connector ${name}`);
        await notify(repo, { action: "rotate", connector_id: c.id });
        return [`connector ${c.name}: new token (shown once): ${token}`, "the old token no longer works; live connection closed"];
      }
      case "unpair": {
        const c = await repo.connectorByName(need());
        if (!c) throw new UsageError(`no connector ${name}`);
        const removed = await repo.deletePairing(c.id);
        await repo.killCodes(c.id);
        await notify(repo, { action: "unpair", connector_id: c.id, tg_chat_id: removed?.tg_chat_id });
        return [removed ? `connector ${c.name} unpaired from ${removed.user_display}` : `connector ${c.name} was not paired (codes invalidated)`];
      }
    }
  }
  if (group === "pairings" && cmd === "find" && rest[0] === "--tg" && rest[1]) {
    const rows = await repo.findPairings(rest[1]);
    if (!rows.length) return ["no pairing found"];
    return rows.map((r) => `${r.name}\t${r.user_display}\ttg_user_id ${r.tg_user_id}\tchat ${r.tg_chat_id}\tsince ${r.created_at.toISOString()}`);
  }
  throw new UsageError(USAGE);
}
