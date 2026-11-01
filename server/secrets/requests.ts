import { createHash, randomBytes } from "node:crypto";

/**
 * One-time links for entering a secret. Each request gets a random 256-bit
 * token; only its hash is kept, in memory, on the Mac. A link works once and
 * for about ten minutes. A restart forgets every open link, which is fine:
 * the owner just asks again.
 */

export const SECRET_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_REQUESTS = 20;

export interface SecretRequest {
  name: string;
  description: string;
  conversationId?: string;
  createdAt: number;
  expiresAt: number;
}

export type ConsumeResult =
  | { ok: true; request: SecretRequest }
  | { ok: false; reason: "unknown" | "expired" | "used" };

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SecretRequestRegistry {
  private readonly open = new Map<string, SecretRequest>();
  // Hashes of tokens already used or expired, so a second try says why.
  private readonly closed = new Map<string, { reason: "expired" | "used"; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SECRET_REQUEST_TTL_MS,
  ) {}

  create(input: { name: string; description: string; conversationId?: string }): { token: string; request: SecretRequest } {
    this.sweep();
    // A newer request for the same name replaces the older link.
    for (const [hash, req] of this.open) {
      if (req.name === input.name) {
        this.open.delete(hash);
        this.closed.set(hash, { reason: "used", at: this.now() });
      }
    }
    if (this.open.size >= MAX_OPEN_REQUESTS) {
      const oldest = [...this.open.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.open.delete(oldest[0]);
    }
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const request: SecretRequest = {
      name: input.name,
      description: input.description,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.open.set(hashToken(token), request);
    return { token, request };
  }

  /** Looks a token up without using it (to show the form). */
  peek(token: string): ConsumeResult {
    const hash = hashToken(String(token));
    const req = this.open.get(hash);
    if (req) {
      if (this.now() >= req.expiresAt) {
        this.open.delete(hash);
        this.closed.set(hash, { reason: "expired", at: this.now() });
        return { ok: false, reason: "expired" };
      }
      return { ok: true, request: req };
    }
    const closed = this.closed.get(hash);
    return { ok: false, reason: closed ? closed.reason : "unknown" };
  }

  /** Uses a token. It never works again, whatever happens next. */
  consume(token: string): ConsumeResult {
    const result = this.peek(token);
    if (result.ok) {
      const hash = hashToken(String(token));
      this.open.delete(hash);
      this.closed.set(hash, { reason: "used", at: this.now() });
    }
    return result;
  }

  /** Open requests (names only), for list_secrets and the dashboard. */
  pending(): { name: string; expiresAt: number }[] {
    this.sweep();
    return [...this.open.values()].map((r) => ({ name: r.name, expiresAt: r.expiresAt }));
  }

  private sweep(): void {
    const now = this.now();
    for (const [hash, req] of this.open) {
      if (now >= req.expiresAt) {
        this.open.delete(hash);
        this.closed.set(hash, { reason: "expired", at: now });
      }
    }
    // Remember closed tokens for a day, then forget them.
    for (const [hash, info] of this.closed) {
      if (now - info.at > 24 * 60 * 60 * 1000) this.closed.delete(hash);
    }
  }
}

export const secretRequests = new SecretRequestRegistry();
