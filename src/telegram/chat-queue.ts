import { log } from "../log.ts";

/** Updates of one chat run strictly in order; different chats run concurrently. */
export class ChatQueue {
  #tails = new Map<number, Promise<void>>();

  run(chatId: number, fn: () => Promise<unknown>): Promise<void> {
    const prev = this.#tails.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .then(() => {})
      .catch((err) => log.error("chat update failed", { chat: chatId, err, stack: err instanceof Error ? err.stack : undefined }));
    this.#tails.set(chatId, next);
    void next.finally(() => {
      if (this.#tails.get(chatId) === next) this.#tails.delete(chatId);
    });
    return next;
  }

  /** Wait until every queued update has been processed (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#tails.size) await Promise.all([...this.#tails.values()]);
  }
}
