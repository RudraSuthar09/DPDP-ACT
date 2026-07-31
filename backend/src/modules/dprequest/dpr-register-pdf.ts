import PDFDocument from 'pdfkit';
import {
  CONTENT_WIDTH,
  MARGIN,
  drawBrandedCoverHeader,
  drawPageNumbers,
  drawRule,
  ensureSpace,
  labelValue,
} from '../../pdf/pdfkit-layout';
import type { DprRegisterEntry } from './dpr-register.service';

/**
 * FR-DPR-06 — the rights-request register and its on-time-closure evidence.
 *
 * Same pdfkit pipeline as the RoPA (FR-INV-09), the proof-of-consent
 * certificate (FR-CON-08) and the grievance resolution export (FR-GRV-06):
 * same layout helpers, same branding, same page numbering. Four documents, one
 * PDF system.
 *
 * WHAT THIS DOCUMENT IS FOR. A regulator asking "do you answer rights requests
 * inside the statutory period" wants a rate and the workings behind it. So the
 * cover states the rate, and the table shows every request with the deadline it
 * was judged against and the version of the policy that set it — the same
 * citation the queue shows, because a compliance rate computed against
 * deadlines nobody can reconstruct is not evidence of anything.
 *
 * WHAT IT DOES NOT CONTAIN: no subject reference, no contact detail, no
 * requester's words. A register is a record of PROCESS — reference code, right,
 * dates, outcome. Whose request it was is not what this document is about, and
 * a per-person detail belongs in that person's own summary, not in a bundle
 * handed to a regulator.
 */
export function renderDprRegisterPdf(input: {
  organisationName: string;
  generatedAt: Date;
  entries: DprRegisterEntry[];
  stats: { total: number; closed: number; closedOnTime: number; open: number; overdue: number };
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const rate =
      input.stats.closed > 0
        ? `${Math.round((input.stats.closedOnTime / input.stats.closed) * 1000) / 10}%`
        : 'n/a';

    drawBrandedCoverHeader(doc, {
      orgName: input.organisationName,
      title: 'Data Principal Request Register',
      subtitle:
        `Generated ${input.generatedAt.toLocaleString()}. On-time closure: ${rate} ` +
        `(${input.stats.closedOnTime} of ${input.stats.closed} closed requests answered within ` +
        'their statutory deadline). Deadlines are the versioned policy records in force when ' +
        'each request was filed (FR-DPR-03) — not a figure applied retrospectively.',
    });

    doc.moveDown(0.3);
    labelValue(doc, 'Total requests', String(input.stats.total));
    labelValue(doc, 'Closed', `${input.stats.closed} (${input.stats.closedOnTime} on time)`);
    labelValue(doc, 'Still open', `${input.stats.open} (${input.stats.overdue} past deadline)`);
    doc.moveDown(0.5);
    drawRule(doc);
    doc.moveDown(0.5);

    if (input.entries.length === 0) {
      doc.fontSize(10).fillColor('#666').font('Helvetica-Oblique')
        .text('No rights requests have been filed.');
    }

    // Landscape, so the widths below total CONTENT_WIDTH for A4 landscape
    // (742pt) rather than portrait's 495 — the register has eight columns and
    // squeezing them into portrait produced a table nobody could read.
    const cols = [88, 78, 92, 84, 84, 96, 108, 100];
    const headers = ['Reference', 'Right', 'Status', 'Filed', 'Deadline', 'Closed', 'Policy', 'Outcome'];

    const drawHeaderRow = () => {
      doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold');
      let x = MARGIN;
      headers.forEach((h, i) => {
        doc.text(h, x, doc.y, { width: cols[i]!, continued: false, lineBreak: false });
        x += cols[i]!;
      });
      doc.moveDown(0.4);
      drawRule(doc);
      doc.moveDown(0.3);
    };

    drawHeaderRow();

    doc.font('Helvetica').fontSize(8);
    for (const entry of input.entries) {
      ensureSpace(doc, 22);
      const y = doc.y;
      const cells = [
        entry.referenceCode,
        (entry.rightType ?? '—').replace(/_/g, ' '),
        entry.status.replace(/_/g, ' '),
        entry.createdAt.slice(0, 10),
        entry.slaDueAt?.slice(0, 10) ?? '—',
        entry.closedAt?.slice(0, 10) ?? '—',
        entry.slaPolicyVersion ? `${entry.slaPolicyKey} v${entry.slaPolicyVersion}` : 'default',
        outcomeLabel(entry),
      ];
      let x = MARGIN;
      cells.forEach((c, i) => {
        // Overdue and late-closed rows are coloured, so the exceptions are the
        // thing the eye lands on rather than something to be counted by hand.
        doc.fillColor(i === 7 ? outcomeColour(entry) : '#222');
        doc.text(c, x, y, { width: cols[i]! - 4, lineBreak: false, ellipsis: true });
        x += cols[i]!;
      });
      doc.y = y + 13;
    }

    doc.moveDown(1);
    drawRule(doc);
    doc.moveDown(0.4);
    doc.fontSize(7.5).fillColor('#666').font('Helvetica-Oblique').text(
      'On-time closure compares each request’s closure timestamp to the statutory deadline ' +
        'recorded on it when its clock started — never to today’s policy. A request still open ' +
        'is not counted as late until its own deadline has passed. This register lists process ' +
        'facts only: it carries no subject reference, contact detail, or request content.',
      MARGIN,
      doc.y,
      { width: CONTENT_WIDTH },
    );

    drawPageNumbers(doc);
    doc.end();
  });
}

function outcomeLabel(entry: DprRegisterEntry): string {
  if (entry.closedOnTime === true) return 'On time';
  if (entry.closedOnTime === false) return 'Late';
  return entry.overdue ? 'Open — overdue' : 'Open';
}

function outcomeColour(entry: DprRegisterEntry): string {
  if (entry.closedOnTime === true) return '#1a7f37';
  if (entry.closedOnTime === false || entry.overdue) return '#b3261e';
  return '#222';
}
