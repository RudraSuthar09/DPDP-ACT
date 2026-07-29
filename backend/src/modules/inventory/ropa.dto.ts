import { BadRequestException } from '@nestjs/common';

export type RopaFormat = 'pdf' | 'xlsx';

/** Request parsing for POST /inventory/ropa/export. */
export function parseRopaExportInput(body: unknown): { format: RopaFormat } {
  const obj = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const format = (obj as Record<string, unknown>).format;
  if (format !== 'pdf' && format !== 'xlsx') {
    throw new BadRequestException('format must be "pdf" or "xlsx".');
  }
  return { format };
}
