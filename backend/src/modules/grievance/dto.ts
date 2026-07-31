import { BadRequestException } from '@nestjs/common';
import { GRIEVANCE_CATEGORIES, type GrievanceCategory } from '@dpdp/shared';

/**
 * Grievance's own small parser, in the same hand-written style as every other
 * module's dto.ts (no class-validator — see request/dto.ts's header). Kept
 * separate from the generic submission body: `parseSubmitRequest` in
 * `request/dto.ts` still owns subject/body/contactChannel/contactValue
 * unchanged, and this only ever validates the one field that is genuinely
 * grievance-only.
 */

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export function parseGrievanceCategory(input: unknown): GrievanceCategory {
  const body = asRecord(input);
  const value = body.category;
  if (typeof value !== 'string' || !(GRIEVANCE_CATEGORIES as readonly string[]).includes(value)) {
    throw new BadRequestException(`category must be one of: ${GRIEVANCE_CATEGORIES.join(', ')}`);
  }
  return value as GrievanceCategory;
}
