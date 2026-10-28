export class AsrError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AsrError";
    this.status = status;
  }
}

/**
 * giga-runner (OpenAI-compatible): POST <base>/audio/transcriptions, multipart `file`, Bearer key → {"text"}.
 * `baseUrl` follows the OpenAI convention and includes `/v1`; a base without a version gets `/v1` appended.
 */
export class AsrClient {
  readonly url: string;
  #apiKey?: string;
  #timeoutMs: number;

  constructor(baseUrl: string, apiKey?: string, timeoutMs = 120_000) {
    const base = baseUrl.replace(/\/+$/, "");
    this.url = `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/audio/transcriptions`;
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
  }

  async transcribe(data: Buffer, filename: string, mime: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);
    const res = await fetch(this.url, {
      method: "POST",
      body: form,
      headers: this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {},
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new AsrError(res.status, `ASR ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new AsrError(502, "ASR response has no text");
    return body.text.trim();
  }
}
