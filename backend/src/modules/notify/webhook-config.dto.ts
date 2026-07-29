import { BadRequestException } from '@nestjs/common';

export interface WebhookConfigInput {
  url: string | null;
  enabled: boolean;
}

/** FR-CON-07: the tenant's webhook endpoint. `url: null` clears it (delivery
 *  becomes a silent no-op, same as never having configured one). */
export function parseWebhookConfigInput(body: unknown): WebhookConfigInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  const obj = body as Record<string, unknown>;

  let url: string | null = null;
  if (obj.url !== undefined && obj.url !== null) {
    if (typeof obj.url !== 'string' || obj.url.trim().length === 0) {
      throw new BadRequestException('url, if present, must be a non-empty string.');
    }
    url = obj.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('url must be a valid, absolute URL (e.g. https://example.com/webhooks).');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException('url must use http:// or https://.');
    }
  }

  const enabled = obj.enabled === undefined ? true : Boolean(obj.enabled);

  return { url, enabled };
}
