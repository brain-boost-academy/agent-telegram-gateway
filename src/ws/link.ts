import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { BlobReceiver, Peer, type PayloadOf, type ProtocolError } from "@brain-boost-academy/agent-protocol";
import { log } from "../log.ts";

/** One authenticated connector WebSocket: send queue (Peer), blob assembly, serial inbound processing. */
export class ConnectorLink {
  readonly connectorId: string;
  readonly name: string;
  readonly ip: string;
  readonly ws: WebSocket;
  readonly peer: Peer;
  readonly blobs: BlobReceiver;
  /** sha256 of the token this link authenticated with; re-checked against the database (revoke/rotate). */
  readonly tokenHash: Buffer;
  /** blob.begin/chunk failures, answered again on the blob's `blob.end` (the sender waits for that one). */
  readonly failedBlobs = new Map<string, ProtocolError>();
  hello?: PayloadOf<"hello">;
  #blobDir: string;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    ws: WebSocket,
    connector: { id: string; name: string },
    tokenHash: Buffer,
    ip: string,
    blobDir: string,
    maxOutboundBytes: number,
    blobOpts: { doneTtlMs?: number },
  ) {
    this.ws = ws;
    this.connectorId = connector.id;
    this.name = connector.name;
    this.tokenHash = tokenHash;
    this.ip = ip;
    this.peer = new Peer(
      { send: (data, cb) => (ws.readyState === ws.OPEN ? ws.send(data, cb) : cb(new Error("socket not open"))) },
      { onSendError: (err) => log.debug("ws send failed", { connector: this.name, err }) },
    );
    this.#blobDir = blobDir;
    this.blobs = new BlobReceiver(blobDir, maxOutboundBytes, blobOpts);
  }

  static async open(
    ws: WebSocket,
    connector: { id: string; name: string },
    tokenHash: Buffer,
    ip: string,
    maxOutboundBytes: number,
    blobOpts: { doneTtlMs?: number } = {},
  ): Promise<ConnectorLink> {
    const dir = await mkdtemp(join(tmpdir(), "gw-blobs-"));
    return new ConnectorLink(ws, connector, tokenHash, ip, dir, maxOutboundBytes, blobOpts);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Run inbound handlers strictly in arrival order (streaming updates must not reorder). */
  enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(fn).catch((err) => log.error("connector message handler failed", { connector: this.name, err }));
    this.#chain = run;
    return run;
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(code, reason);
    this.dispose();
  }

  /** Called once the socket is gone. */
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.peer.close("connection closed");
    this.failedBlobs.clear();
    void this.blobs
      .clear()
      .finally(() => rm(this.#blobDir, { recursive: true, force: true }))
      .catch((err) => log.debug("blob dir cleanup failed", { err }));
  }
}
