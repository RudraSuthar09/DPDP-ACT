import PDFDocument from 'pdfkit';
import type { RopaEntryRow } from './ropa.repository';
import {
  CONTENT_WIDTH,
  MARGIN,
  drawBrandedCoverHeader,
  drawPageNumbers,
  drawRule,
  ensureSpace,
  labelValue,
} from '../../pdf/pdfkit-layout';

/**
 * FR-INV-09 — the Record of Processing Activities, rendered as PDF.
 *
 * Built with pdfkit (pure JS, no native deps, no HTML/browser rendering
 * engine involved — nothing like that already exists in this repo, and
 * hand-rolling a correct PDF object graph/xref table for a document this
 * size was judged not worth the correctness risk for a regulator-facing
 * artefact). Helvetica is a base-14 PDF font — no font file to embed or ship.
 *
 * Layout conventions (margins, cover header, page numbers) live in
 * `pdf/pdfkit-layout.ts`, shared with the proof-of-consent certificate
 * (FR-CON-08, Prompt 22) — one branded PDF pipeline, not two.
 */

const LEGAL_BASIS_LABELS: Record<string, string> = {
  consent: 'Consent',
  legitimate_use: 'Legitimate use',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
  other: 'Other',
};

const PII_DECISION_LABELS: Record<string, string> = {
  accepted: 'Confirmed',
  rejected: 'Reviewed — not classified as PII',
  undecided: 'Not yet reviewed',
};

export function renderRopaPdf(input: {
  organisationName: string;
  generatedAt: Date;
  entries: RopaEntryRow[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawCoverHeader(doc, input.organisationName, input.generatedAt, input.entries.length);

    if (input.entries.length === 0) {
      doc.moveDown(2).fontSize(11).fillColor('#555').text('No active data elements are recorded yet.');
    } else {
      for (const entry of input.entries) {
        ensureSpace(doc, estimateEntryHeight(entry));
        drawEntry(doc, entry);
      }
    }

    drawPageNumbers(doc);
    doc.end();
  });
}

function drawCoverHeader(doc: PDFKit.PDFDocument, orgName: string, generatedAt: Date, count: number) {
  drawBrandedCoverHeader(doc, {
    orgName,
    title: 'Record of Processing Activities',
    subtitle:
      `Generated ${generatedAt.toLocaleString()} — reflects current data at generation time, ` +
      `not a cached snapshot. ${count} active data element${count === 1 ? '' : 's'}.`,
  });
}

function drawEntry(doc: PDFKit.PDFDocument, entry: RopaEntryRow) {
  doc.fontSize(13).fillColor('#111').font('Helvetica-Bold').text(entry.category);
  doc.moveDown(0.15);

  if (entry.description) {
    doc.fontSize(10).fillColor('#444').font('Helvetica').text(entry.description);
    doc.moveDown(0.15);
  }

  labelValue(doc, 'Storage location', entry.storage_location);
  labelValue(doc, 'PII classification', piiSummary(entry));

  const systemsText = entry.systems.length
    ? entry.systems.map((s) => `${s.name} (${s.systemType}${s.hostingLocation ? `, ${s.hostingLocation}` : ''})`).join('; ')
    : 'None recorded';
  labelValue(doc, 'Systems', systemsText);

  const vendorsText = entry.vendors.length
    ? entry.vendors
        .map((v) => `${v.name}${v.country ? ` (${v.country})` : ''}${v.transferNotes ? ` — ${v.transferNotes}` : ''}`)
        .join('; ')
    : 'None recorded';
  labelValue(doc, 'Vendors / recipients', vendorsText);

  doc.moveDown(0.2);
  doc.fontSize(9.5).fillColor('#333').font('Helvetica-Bold').text('Processing purposes');
  doc.moveDown(0.1);

  if (entry.purposes.length === 0) {
    doc.fontSize(9.5).fillColor('#999').font('Helvetica-Oblique').text('No processing purpose recorded yet.');
  } else {
    drawPurposeTable(doc, entry.purposes);
  }

  doc.moveDown(0.4);
  drawRule(doc);
  doc.moveDown(0.4);
}

function drawPurposeTable(doc: PDFKit.PDFDocument, purposes: RopaEntryRow['purposes']) {
  const colX = { purpose: MARGIN, basis: MARGIN + 200, retention: MARGIN + 330 };
  const colW = { purpose: 195, basis: 125, retention: CONTENT_WIDTH - 325 };

  const headerY = doc.y;
  doc.fontSize(8.5).fillColor('#666').font('Helvetica-Bold');
  doc.text('PURPOSE', colX.purpose, headerY, { width: colW.purpose });
  doc.text('LEGAL BASIS', colX.basis, headerY, { width: colW.basis });
  doc.text('RETENTION', colX.retention, headerY, { width: colW.retention });
  doc.moveDown(0.3);

  for (const p of purposes) {
    ensureSpace(doc, 30);
    const rowY = doc.y;
    doc.fontSize(9).fillColor('#222').font('Helvetica');
    doc.text(p.purposeName, colX.purpose, rowY, { width: colW.purpose });
    const basisText = LEGAL_BASIS_LABELS[p.legalBasis] ?? p.legalBasis;
    doc.text(p.legalBasisNote ? `${basisText} (${p.legalBasisNote})` : basisText, colX.basis, rowY, {
      width: colW.basis,
    });
    doc.text(p.retentionPeriod, colX.retention, rowY, { width: colW.retention });
    doc.moveDown(0.4);
  }
}

function piiSummary(entry: RopaEntryRow): string {
  if (!entry.pii_category) {
    return 'No suggestion available';
  }
  const confidence = entry.pii_confidence ? ` (${entry.pii_confidence} confidence)` : '';
  return `${entry.pii_category}${confidence} — ${PII_DECISION_LABELS[entry.pii_decision]}`;
}

/** Rough upper-bound estimate so we page-break BEFORE splitting an entry awkwardly. */
function estimateEntryHeight(entry: RopaEntryRow): number {
  return 140 + entry.purposes.length * 22 + (entry.description ? 20 : 0);
}
