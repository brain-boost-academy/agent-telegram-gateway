import { createHash, randomBytes } from "node:crypto";

/** 256-bit connector token, base64url (D10). Shown once by the admin CLI. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the sha256 of a token is stored and compared (lookup by hash). */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Extract the bearer token from an Authorization header. */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1];
}
