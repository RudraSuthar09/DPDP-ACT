import { BadRequestException } from '@nestjs/common';
import {
  GATEWAY_FOLDER_ACCESS,
  type GatewayAuthorizeFolderRequest,
  type GatewayFolderAccess,
  type GatewayRevokeFolderRequest,
} from '@dpdp/shared';

/**
 * The device-facing authorize-folder body. Total, hand-written parsing (same
 * style as every other DTO here) with two rules that matter for security:
 *
 *   1. NOTHING identifying is read from the body — no tenantId, deviceId,
 *      userId, sourceId or storageRootId. Identity comes from the verified
 *      device token (GatewayDeviceMiddleware). Anything like that in the body
 *      is ignored, and a test asserts this parser never reads those names.
 *   2. The label is a DISPLAY NAME, never a path. A value containing a path
 *      separator, a drive letter, a UNC prefix or '..' is refused outright —
 *      the central platform must not learn the folder's location (I1), and a
 *      label is not a place.
 */
const MAX_LABEL = 120;

export function parseAuthorizeFolder(body: unknown): GatewayAuthorizeFolderRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  const obj = body as Record<string, unknown>;

  const access = obj['access'];
  if (typeof access !== 'string' || !(GATEWAY_FOLDER_ACCESS as readonly string[]).includes(access)) {
    throw new BadRequestException(`access must be one of: ${GATEWAY_FOLDER_ACCESS.join(', ')}.`);
  }

  const raw = obj['label'];
  if (typeof raw !== 'string') throw new BadRequestException('label is required and must be a string.');
  const label = raw.trim();
  if (label.length < 1 || label.length > MAX_LABEL) {
    throw new BadRequestException(`label must be between 1 and ${MAX_LABEL} characters.`);
  }
  if (looksLikeAPath(label)) {
    throw new BadRequestException('label must be a folder name, not a path. The folder\'s location stays on the Gateway computer.');
  }

  return { label, access: access as GatewayFolderAccess };
}

/** A name, not a place: no separators, no drive, no UNC, no traversal, no NUL. */
export function looksLikeAPath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('..') ||
    /^[a-zA-Z]:/.test(value)
  );
}

/**
 * The staff-facing remove-folder body: a label and nothing else. Same two
 * rules as above — no identity of any kind is read from the body (the tenant
 * and the acting user come from the session), and the label is a display
 * name, never a path, so a crafted "label" can never be aimed at a place.
 */
export function parseRevokeFolder(body: unknown): GatewayRevokeFolderRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  const raw = (body as Record<string, unknown>)['label'];
  if (typeof raw !== 'string') throw new BadRequestException('label is required and must be a string.');
  const label = raw.trim();
  if (label.length < 1 || label.length > MAX_LABEL) {
    throw new BadRequestException(`label must be between 1 and ${MAX_LABEL} characters.`);
  }
  if (looksLikeAPath(label)) {
    throw new BadRequestException('label must be a folder name, not a path.');
  }
  return { label };
}
