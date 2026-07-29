/**
 * Shared pdfkit layout conventions for every regulator-facing PDF this
 * platform generates — first the RoPA export (FR-INV-09, Prompt 16), now the
 * proof-of-consent certificate (FR-CON-08). Extracted rather than duplicated:
 * "reuse the branded PDF pipeline" means the same code draws the header, the
 * page numbers, and the rules, not merely that both call pdfkit separately.
 *
 * Tenant branding today is exactly one field: the organisation's name. No
 * logo/colour/letterhead columns exist on `organisations` (id, tenant_id,
 * name, tier, created_at, updated_at) — so that is the whole of "branded"
 * until a future prompt adds more, and this is the one place that would change.
 */

export const MARGIN = 50;
export const PAGE_WIDTH = 595.28; // A4 points
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** The cover header every certificate/report opens with: platform mark, the
 *  tenant's own name (the branding), a document title, and a subtitle line
 *  (usually "generated at X — reflects state at generation time"). */
export function drawBrandedCoverHeader(
  doc: PDFKit.PDFDocument,
  input: { orgName: string; title: string; subtitle: string },
): void {
  doc.fontSize(9).fillColor('#888').text('DPDP Compliance Platform', { align: 'right' });
  doc.moveDown(0.5);
  doc.fontSize(20).fillColor('#111').font('Helvetica-Bold').text(input.orgName);
  doc.fontSize(16).fillColor('#333').font('Helvetica-Bold').text(input.title);
  doc.moveDown(0.3);
  doc.fontSize(9.5).fillColor('#666').font('Helvetica').text(input.subtitle);
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.5);
}

export function drawRule(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).strokeColor('#ddd').lineWidth(0.5).stroke();
}

/** Page-break BEFORE splitting a logical block awkwardly, rather than after. */
export function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < needed) {
    doc.addPage();
  }
}

export function labelValue(doc: PDFKit.PDFDocument, label: string, value: string): void {
  const y = doc.y;
  doc.fontSize(8.5).fillColor('#888').font('Helvetica-Bold').text(`${label.toUpperCase()}  `, MARGIN, y, {
    continued: true,
    width: CONTENT_WIDTH,
  });
  doc.fontSize(9.5).fillColor('#222').font('Helvetica').text(value);
  doc.moveDown(0.1);
}

/**
 * Writing at all within the last ~50pt of a page makes pdfkit's own
 * page-break check (which fires on ANY .text() call, even with explicit
 * coordinates — it compares against page.margins.bottom, not just the
 * automatic text-flow cursor) think the footer itself doesn't fit, and it
 * silently starts a stray extra page for it. Zeroing the bottom margin for
 * the duration of the write is the standard pdfkit workaround.
 */
export function drawPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  const originalBottom = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc
      .fontSize(8)
      .fillColor('#999')
      .text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, doc.page.height - 35, {
        width: CONTENT_WIDTH,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = originalBottom;
  }
}
