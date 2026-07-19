import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditContextService } from '../audit/audit-context.service';
import { classifyPii } from './pii-classifier';
import { createSchemaSource, type SchemaSourceInput } from './schema-source/schema-source.factory';
import {
  DataElementsRepository,
  type DataElementRow,
  type DiscoveredElement,
} from './data-elements.repository';

/**
 * Data Inventory (FR-INV). In Stage 1 this is the S4 seam made concrete: build a
 * SchemaSource, walk its schema metadata, classify PII by NAME (a suggestion),
 * and persist — all through the one interface, so a hand-typed map (ManualEntry)
 * and an uploaded file (FileImport) flow through identical code.
 *
 * The method that would let a source hand back a customer record does not exist to
 * call — the walk below can only ever see names, types, and structure (I1).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly repo: DataElementsRepository,
    private readonly audit: AuditContextService,
  ) {}

  async discover(
    input: SchemaSourceInput,
    sourceRef: string,
  ): Promise<{ discovered: number; elements: DiscoveredElement[] }> {
    const source = createSchemaSource(input);

    if (!(await source.testConnection())) {
      throw new BadRequestException('The schema source has nothing to discover.');
    }

    const elements: DiscoveredElement[] = [];
    // The entire discovery surface: schemas → tables → columns/constraints. Note
    // there is no step that reads a row — there is no method for it (S4/I1).
    for (const schema of await source.listSchemas()) {
      for (const table of await source.listTables(schema)) {
        const columns = await source.listColumns(table);
        for (const column of columns) {
          elements.push({
            sourceKind: source.kind,
            sourceRef,
            schemaName: schema,
            tableName: table,
            columnName: column.name,
            dataType: column.type,
            nullable: column.nullable,
            comment: column.comment ?? null,
            // A suggestion the client confirms — the platform advises, never decides.
            piiCategory: classifyPii(column.name),
          });
        }
      }
    }

    const discovered = await this.repo.upsertMany(elements);

    this.audit.annotate({
      targetType: 'inventory_discovery',
      targetId: sourceRef,
      reason: `Discovered ${discovered} data element(s) via ${source.kind}`,
      afterState: {
        sourceKind: source.kind,
        elements: discovered,
        piiSuggested: elements.filter((e) => e.piiCategory !== null).length,
      },
    });

    return { discovered, elements };
  }

  list(): Promise<DataElementRow[]> {
    return this.repo.list();
  }
}
