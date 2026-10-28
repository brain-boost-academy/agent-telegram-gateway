// R19: ≥3 replacements (4409) of one connector within 10 min from ≥2 distinct IPs
// → warn the owner, at most once per hour per connector.

export const REPLACE_WINDOW_MS = 10 * 60_000;
export const REPLACE_THRESHOLD = 3;
export const ALERT_COOLDOWN_MS = 60 * 60_000;

type Event = { at: number; ips: string[] };

export class ReplaceAlert {
  #events = new Map<string, Event[]>();
  #lastAlert = new Map<string, number>();

  /** Record one replacement (old socket IP, new socket IP). Returns the IPs to report when an alert is due. */
  record(connectorId: string, oldIp: string, newIp: string, now = Date.now()): string[] | null {
    const events = (this.#events.get(connectorId) ?? []).filter((e) => now - e.at < REPLACE_WINDOW_MS);
    events.push({ at: now, ips: [oldIp, newIp] });
    this.#events.set(connectorId, events);
    if (events.length < REPLACE_THRESHOLD) return null;
    const ips = [...new Set(events.flatMap((e) => e.ips))];
    if (ips.length < 2) return null;
    const last = this.#lastAlert.get(connectorId);
    if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return null;
    this.#lastAlert.set(connectorId, now);
    return ips;
  }
}
