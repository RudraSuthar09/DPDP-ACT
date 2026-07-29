/**
 * FR-CON-09: the Consent SDK. Zero runtime dependencies, <5KB gzipped
 * (enforced by size-check.mjs in this package's build script), browser-only.
 *
 * Talks to exactly two real backend endpoints — POST /consent/public/events
 * and POST /consent/public/withdraw (ConsentPublicController) — authenticated
 * by a tenant-scoped public API key (X-Consent-Api-Key), never a staff JWT.
 * Everything server-side still runs through the same ConsentService write
 * path staff use; this SDK is just a thin, embeddable client for it.
 */

export interface ConsentSDKConfig {
  /** A key minted via the tenant's Integration page (POST /consent/api-keys).
   *  Write-only and safe to embed in public client-side JS. */
  apiKey: string;
  /** Overrides the API origin. Defaults to the origin this script itself was
   *  loaded from — correct as long as the SDK is served from the same origin
   *  as the API (the Stage-1 delivery path, see main.ts's useStaticAssets).
   *  Required if the SDK is not loaded via a plain <script src="..."> tag. */
  apiBaseUrl?: string;
}

export interface GrantOptions {
  /** The tenant's own internal customer id, raw. Pseudonymised server-side
   *  (HMAC) — this SDK never hashes it and never stores it (I2). */
  customerId: string;
  purposeId: string;
  noticeVersionId: string;
  /** Auto-generated if omitted — protects against a double-click/retry
   *  firing two writes for what the visitor experienced as one action. */
  idempotencyKey?: string;
}

export interface WithdrawOptions {
  customerId: string;
  purposeId: string;
  reason?: string;
}

export interface ConsentEventResult {
  eventId: string;
  subjectRef: string;
  purposeName: string;
  recordedAt: string;
  deduplicated: boolean;
}

export interface WithdrawResult extends ConsentEventResult {
  purposeId: string;
  wasAlreadyWithdrawn: boolean;
}

/** Captured at module-evaluation time — document.currentScript is only valid
 *  during the synchronous execution of a classic <script> tag, not later. */
const scriptOrigin = detectScriptOrigin();

export class DPDPConsent {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: ConsentSDKConfig) {
    if (!config || !config.apiKey) {
      throw new Error('DPDPConsent: apiKey is required.');
    }
    const base = config.apiBaseUrl ?? scriptOrigin;
    if (!base) {
      throw new Error(
        'DPDPConsent: apiBaseUrl is required when the SDK is not loaded via a <script src="..."> tag.',
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = base.replace(/\/+$/, '');
  }

  /** Records a consent grant (or any status) — POST /consent/public/events. */
  grant(options: GrantOptions): Promise<ConsentEventResult> {
    return this.post<ConsentEventResult>('/consent/public/events', {
      customerId: options.customerId,
      purposeId: options.purposeId,
      noticeVersionId: options.noticeVersionId,
      status: 'GRANTED',
      idempotencyKey: options.idempotencyKey ?? generateIdempotencyKey(),
    });
  }

  /** One-click withdrawal — POST /consent/public/withdraw. Always writes a
   *  fresh WITHDRAWN event; never blocks on "already withdrawn". */
  withdraw(options: WithdrawOptions): Promise<WithdrawResult> {
    return this.post<WithdrawResult>('/consent/public/withdraw', {
      customerId: options.customerId,
      purposeId: options.purposeId,
      reason: options.reason,
    });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Consent-Api-Key': this.apiKey },
      body: JSON.stringify(body),
    });

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }

    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'message' in data
          ? String((data as { message: unknown }).message)
          : res.statusText;
      throw new Error(`DPDPConsent: request failed (${res.status}): ${message}`);
    }

    return data as T;
  }
}

function detectScriptOrigin(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src) {
    return undefined;
  }
  try {
    return new URL(script.src).origin;
  } catch {
    return undefined;
  }
}

function generateIdempotencyKey(): string {
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // No Web Crypto at all (very old browser). This key only needs to be
  // unique enough to dedupe a double-click — it is never a security
  // boundary, since the server independently derives its own deterministic
  // fallback when idempotencyKey is absent — so Math.random() is acceptable here.
  return `idk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

if (typeof window !== 'undefined') {
  (window as unknown as { DPDPConsent: typeof DPDPConsent }).DPDPConsent = DPDPConsent;
}
