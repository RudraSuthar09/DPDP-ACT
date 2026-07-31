import PDFDocument from 'pdfkit';
import type { AuditChainReport, AuditEntry } from '@dpdp/shared';
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
 * FR-AUD-05 — the evidence bundle PDF.
 *
 * Same pdfkit pipeline as every other regulator-facing document this platform
 * produces (RoPA, proof-of-consent, grievance resolution, the DPR register,
 * the Breach closure packet) — same layout helpers, same branding, same page
 * numbering, landscape for the same reason the DPR/Breach tables are: a
 * multi-column log reads better wide than tall. Six documents, one PDF system,
 * deliberately never the Playwright/HTML pipeline the original master
 * document sketched — this platform settled on pdfkit for every export before
 * this one, and a sixth document is not the place to introduce a second
 * rendering runtime and a headless-Chromium dependency for it.
 *
 * WHAT MAKES THIS "VERIFIABLE" RATHER THAN JUST "A LIST": the cover states the
 * chain's own verification result — intact or not, how many entries were
 * walked, and the head hash — computed by the SAME `app.verify_audit_chain()`
 * a tenant would run themselves from the dashboard. A regulator does not have
 * to trust the PDF; they can ask the tenant to re-run "Verify chain" and
 * compare the head hash printed here against what it reports now.
 */
export function renderEvidenceBundlePdf(input: {
  organisationName: string;
  generatedAt: Date;
  report: AuditChainReport;
  entries: AuditEntry[];
}): Promise<Buffer> {
  const { report, entries } = input;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawBrandedCoverHeader(doc, {
      orgName: input.organisationName,
      title: 'Evidence Bundle',
      subtitle:
        `Generated ${input.generatedAt.toLocaleString()}. Every audit entry recorded for this ` +
        'organisation, in chain order, together with the result of re-verifying the hash chain at ' +
        'the moment of export (FR-AUD-05). This is a full export, not a sample or a page: nothing ' +
        'between the first entry and the one below was left out.',
    });

    doc.moveDown(0.2);
    labelValue(doc, 'Chain status', report.intact ? 'INTACT — no tampering detected' : 'BROKEN — see problems below');
    labelValue(doc, 'Entries in this chain', String(report.entriesChecked));
    labelValue(doc, 'Entries in this export', String(entries.length));
    labelValue(doc, 'Head hash (most recent entry)', report.headHash ?? '(chain is empty)');
    if (!report.intact) {
      for (const b of report.breaks) {
        labelValue(doc, `Problem at seq ${b.seq}`, b.problem);
      }
    }

    // A per-module breakdown — cheap, and it is what lets a reader skim "how
    // much of this bundle is Identity vs. Consent vs. Breach" before reading
    // 400 rows one at a time.
    const byModule = new Map<string, number>();
    for (const e of entries) {
      const mod = e.action.split('.')[0] ?? 'other';
      byModule.set(mod, (byModule.get(mod) ?? 0) + 1);
    }
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text('Entries by module:');
    doc.fontSize(8.5).font('Helvetica').fillColor('#444').text(
      [...byModule.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([mod, count]) => `${mod} (${count})`)
        .join('  ·  ') || 'none',
      { width: CONTENT_WIDTH },
    );

    doc.moveDown(0.6);
    drawRule(doc);
    doc.moveDown(0.4);

    if (entries.length === 0) {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#666').text('No audit entries exist for this organisation yet.');
      drawPageNumbers(doc);
      doc.end();
      return;
    }

    // Landscape A4 content width (~742pt). Eight columns; correlationId and the
    // hash are deliberately NOT columns — they are what "Verify chain" checks,
    // not what a reader scans a log by, and would not fit legibly regardless.
    const cols = [42, 96, 60, 130, 90, 100, 130, 94];
    const headers = ['Seq', 'When', 'Outcome', 'Action', 'Actor', 'Target', 'Reason', 'Correlation'];

    doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold');
    let x = MARGIN;
    headers.forEach((h, i) => {
      doc.text(h, x, doc.y, { width: cols[i]!, lineBreak: false });
      x += cols[i]!;
    });
    doc.moveDown(0.4);
    drawRule(doc);
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7.5);
    for (const e of entries) {
      ensureSpace(doc, 20);
      const y = doc.y;
      const actor = e.actorLabel ?? e.actorId ?? '—';
      const target = e.targetType ? `${e.targetType}${e.targetId ? `/${e.targetId.slice(0, 8)}…` : ''}` : '—';
      const cells = [
        String(e.seq),
        new Date(e.occurredAt).toISOString().slice(0, 19).replace('T', ' '),
        e.outcome,
        e.action,
        actor,
        target,
        e.reason ?? '—',
        e.correlationId.slice(0, 8) + '…',
      ];
      let cx = MARGIN;
      cells.forEach((c, i) => {
        doc.fillColor(i === 2 && e.outcome !== 'success' ? '#b3261e' : '#222');
        doc.text(c, cx, y, { width: cols[i]! - 3, lineBreak: false, ellipsis: true });
        cx += cols[i]!;
      });
      doc.y = y + 11;
    }

    doc.moveDown(1);
    drawRule(doc);
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#666').text(
      'Each row above is one entry in the hash-chained audit_log for this organisation, in the exact ' +
        'order the chain links them. before/after state and the per-entry hash are omitted from this ' +
        'table for legibility — request the underlying export or use the dashboard viewer (FR-AUD-04) ' +
        'to inspect a specific entry in full.',
      MARGIN,
      doc.y,
      { width: CONTENT_WIDTH },
    );

    drawPageNumbers(doc);
    doc.end();
  });
}
