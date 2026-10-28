import { get as httpGet, type Agent } from "node:http";
import { get as httpsGet } from "node:https";

export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export class TooLargeError extends Error {}

/** GET a Bot API file URL through the same proxy agent as API calls; aborts beyond `maxBytes`. */
export function download(url: string, agent: Agent | undefined, maxBytes = TG_DOWNLOAD_LIMIT, timeoutMs = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https:") ? httpsGet : httpGet;
    const req = get(url, { agent, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new TooLargeError(`file exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("download timeout")));
    req.on("error", reject);
  });
}
