import type { SchemaSource } from '@dpdp/shared';
import { FileImportSchemaSource } from './file-import.source';
import { ManualEntrySchemaSource, type ManualDeclaration } from './manual-entry.source';

/**
 * "One interface, many sources." The whole S4 idea, expressed as a factory: the
 * inventory module asks for a SchemaSource by kind and gets one, never knowing or
 * caring which concrete class it is. Stage 1 has exactly two kinds; the later
 * kinds (SaaS adapters at Stage 2, DB introspection drivers and the on-prem agent
 * at Stage 6) are added as cases HERE — and every one of them, by dint of the
 * interface, still has no readRows(). Adding a driver cannot add a data-read path.
 */
export type SchemaSourceInput =
  | { kind: 'manual'; declaration: ManualDeclaration }
  | { kind: 'file_import'; fileName: string; tableName: string; csvText: string };

export function createSchemaSource(input: SchemaSourceInput): SchemaSource {
  switch (input.kind) {
    case 'manual':
      return new ManualEntrySchemaSource(input.declaration);
    case 'file_import':
      return new FileImportSchemaSource(input);
    // No default: a new kind must be added above, where the compiler will make
    // sure it too satisfies SchemaSource — i.e. still has no readRows().
  }
}
