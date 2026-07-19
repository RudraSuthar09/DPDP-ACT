import type { SchemaSource } from '@dpdp/shared';
import { ManualEntrySchemaSource } from './manual-entry.source';
import { FileImportSchemaSource } from './file-import.source';
import { createSchemaSource } from './schema-source.factory';

/**
 * Invariant I1, enforced by the TYPE SYSTEM and pinned here: a SchemaSource can
 * discover structure but can never read a row. The interface has no readRows();
 * this test proves no implementation smuggled one back in under another name, and
 * that a FileImport source given a file full of customer data cannot surface a
 * single value of it.
 *
 * If someone adds `readRows` (or `getRows`, `sampleRows`, `readData`, …) to a
 * source, this build goes red — which is the whole product promise made checkable:
 * "a connector accidentally reads customer rows" cannot happen if the method to do
 * so does not exist.
 */

/** Any method whose name suggests it returns row DATA rather than structure. */
const ROW_READING_NAME = /rows?\b|record|\bvalues?\b|sample|rawdata|read_?data|dump|exfil/i;

function prototypeMethodNames(instance: object): string[] {
  const names = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') {
        names.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

const SENTINEL = 'AADHAAR-999988887777-DO-NOT-STORE';

const CSV_WITH_REAL_DATA = [
  'full_name,aadhaar_number,mobile,email,notes',
  `Asha Rao,${SENTINEL},9876543210,asha@example.com,VIP patient`,
  `Ravi Kumar,111122223333,9000000000,ravi@example.com,follow-up`,
].join('\n');

describe('S4 SchemaSource — I1 is enforced by the type, not by review', () => {
  const sources: Array<[string, SchemaSource]> = [
    [
      'ManualEntry',
      new ManualEntrySchemaSource({
        schemas: [
          { name: 'crm', tables: [{ name: 'customers', columns: [{ name: 'email', type: 'text', nullable: false }] }] },
        ],
      }),
    ],
    [
      'FileImport',
      new FileImportSchemaSource({
        fileName: 'patients.csv',
        tableName: 'patients',
        csvText: CSV_WITH_REAL_DATA,
      }),
    ],
  ];

  it.each(sources)('%s exposes no row-reading method', (_name, source) => {
    const methods = prototypeMethodNames(source);
    const offenders = methods.filter((m) => ROW_READING_NAME.test(m));
    expect(offenders).toEqual([]);

    // And spell out the common culprits explicitly, so the intent is unmistakable.
    for (const forbidden of ['readRows', 'getRows', 'fetchRows', 'readData', 'sample', 'dump']) {
      expect(typeof (source as unknown as Record<string, unknown>)[forbidden]).not.toBe('function');
    }
  });

  it.each(sources)('%s exposes exactly the structure-only surface', async (_name, source) => {
    // The interface's whole method set — nothing that returns data.
    expect(typeof source.testConnection).toBe('function');
    expect(typeof source.listSchemas).toBe('function');
    expect(typeof source.listTables).toBe('function');
    expect(typeof source.listColumns).toBe('function');
    expect(typeof source.listConstraints).toBe('function');
    expect(await source.testConnection()).toBe(true);
  });

  it('FileImport discovers column NAMES from the header and nothing below it', async () => {
    const source = createSchemaSource({
      kind: 'file_import',
      fileName: 'patients.csv',
      tableName: 'patients',
      csvText: CSV_WITH_REAL_DATA,
    });

    const columns = await source.listColumns('patients');
    expect(columns.map((c) => c.name)).toEqual([
      'full_name',
      'aadhaar_number',
      'mobile',
      'email',
      'notes',
    ]);

    // The critical assertion: no data value survived. The sentinel from a DATA row
    // appears nowhere — not in the columns, and not anywhere on the source object,
    // because the constructor parsed the header and discarded the rest (I1).
    expect(JSON.stringify(columns)).not.toContain(SENTINEL);
    expect(JSON.stringify(source)).not.toContain(SENTINEL);
    expect(JSON.stringify(source)).not.toContain('Asha Rao');
  });

  it('ManualEntry serves back the declared structure', async () => {
    const source = createSchemaSource({
      kind: 'manual',
      declaration: {
        schemas: [
          {
            name: 'billing',
            tables: [
              { name: 'invoices', columns: [{ name: 'pan', type: 'text', nullable: false }] },
            ],
          },
        ],
      },
    });
    expect(await source.listSchemas()).toEqual(['billing']);
    expect(await source.listTables('billing')).toEqual(['invoices']);
    expect((await source.listColumns('invoices')).map((c) => c.name)).toEqual(['pan']);
  });
});
