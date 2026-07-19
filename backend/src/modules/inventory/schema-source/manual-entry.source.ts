import type { SchemaColumn, SchemaConstraint, SchemaSource } from '@dpdp/shared';

/**
 * A client's data map, DECLARED through the guided wizard (ingestion path P1).
 * Structure only — names, types, nullability, comments, constraints. There are no
 * rows here to declare, because a wizard is someone describing their data, not
 * exporting it.
 */
export interface ManualTable {
  name: string;
  columns: SchemaColumn[];
  constraints?: SchemaConstraint[];
}
export interface ManualSchema {
  name: string;
  tables: ManualTable[];
}
export interface ManualDeclaration {
  schemas: ManualSchema[];
}

/**
 * S4 implementation #1 — ManualEntry (ingestion path P1). The client fills in a
 * guided form describing their systems; this source serves that description back
 * through the SchemaSource interface, so the inventory module treats a hand-typed
 * map and (one day) a live database driver identically.
 *
 * There is no readRows() — not omitted, unrepresentable: SchemaSource has no such
 * method, and a manual declaration has no rows to return anyway. That is invariant
 * I1 as a fact about the type, not a rule someone has to remember.
 */
export class ManualEntrySchemaSource implements SchemaSource {
  readonly kind = 'manual' as const;

  constructor(private readonly declaration: ManualDeclaration) {}

  async testConnection(): Promise<boolean> {
    return this.declaration.schemas.length > 0;
  }

  async listSchemas(): Promise<string[]> {
    return this.declaration.schemas.map((s) => s.name);
  }

  async listTables(schema: string): Promise<string[]> {
    return this.schema(schema).tables.map((t) => t.name);
  }

  async listColumns(table: string): Promise<SchemaColumn[]> {
    return this.table(table).columns;
  }

  async listConstraints(table: string): Promise<SchemaConstraint[]> {
    return this.table(table).constraints ?? [];
  }

  private schema(name: string): ManualSchema {
    const found = this.declaration.schemas.find((s) => s.name === name);
    if (!found) {
      throw new Error(`Schema '${name}' was not declared.`);
    }
    return found;
  }

  private table(name: string): ManualTable {
    for (const schema of this.declaration.schemas) {
      const table = schema.tables.find((t) => t.name === name);
      if (table) {
        return table;
      }
    }
    throw new Error(`Table '${name}' was not declared.`);
  }
}
