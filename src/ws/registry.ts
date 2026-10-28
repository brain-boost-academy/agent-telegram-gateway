import { CloseCode } from "@brain-boost-academy/agent-protocol";
import type { ConnectorLink } from "./link.ts";
import { log } from "../log.ts";

/** One live link per connector (R5: last wins, the old one is closed with 4409). */
export class Registry {
  #links = new Map<string, ConnectorLink>();

  get(connectorId: string): ConnectorLink | undefined {
    return this.#links.get(connectorId);
  }

  /** Register `link`; returns the replaced link (already being closed with 4409), if any. */
  attach(link: ConnectorLink): ConnectorLink | undefined {
    const old = this.#links.get(link.connectorId);
    this.#links.set(link.connectorId, link);
    if (old && old !== link) {
      log.warn("connector connection replaced", { connector: link.name, old_ip: old.ip, new_ip: link.ip });
      old.close(CloseCode.replaced, "replaced");
      return old;
    }
    return undefined;
  }

  /** Forget `link` if it is still the live one. */
  detach(link: ConnectorLink): boolean {
    if (this.#links.get(link.connectorId) !== link) return false;
    this.#links.delete(link.connectorId);
    return true;
  }

  all(): ConnectorLink[] {
    return [...this.#links.values()];
  }
}
