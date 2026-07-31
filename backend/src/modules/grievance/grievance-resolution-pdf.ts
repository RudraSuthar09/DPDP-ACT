import PDFDocument from 'pdfkit';
import { GRIEVANCE_CATEGORY_LABELS, type GrievanceCategory } from '@dpdp/shared';
import {
  CONTENT_WIDTH,
  MARGIN,
  drawBrandedCoverHeader,
  drawPageNumbers,
  drawRule,
  ensureSpace,
  labelValue,
} from '../../pdf/pdfkit-layout';
import type { GrievanceMilestones, IdentityVerificationSummary, RequestDetail } from './grievance-milestones';

/**
 * FR-GRV-06 — the resolution export, rendered as PDF.
 *
 * Same pipeline as the RoPA export (Prompt 16) and the proof-of-consent
 * certificate (Prompt 22): pdfkit, the shared `pdf/pdfkit-layout.ts` cover
 * header/rule/page-number primitives, buffered chunks resolved to one
 * `Buffer`. Nothing here is cached or persisted — like both precedents, this
 * regenerates fresh from `RequestService.detail()` on every call, so an
 * export can never go stale out from under whoever relies on it.
 */
export function renderGrievanceResolutionPdf(input: {
  organisationName: string;
  generatedAt: Date;
  detail: RequestDetail;
  category: GrievanceCategory | null;
  milestones: GrievanceMilestones;
  identityVerification: IdentityVerificationSummary;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { ticket } = input.detail;

    drawBrandedCoverHeader(doc, {
      orgName: input.organisationName,
      title: 'Grievance Resolution Certificate',
      subtitle:
        `Reference ${ticket.referenceCode} — generated ${input.generatedAt.toLocaleString()}. ` +
        'Evidence that this complaint was received, verified, actioned, and closed ' +
        'within the required time (FR-GRV-06).',
    });

    drawSummary(doc, ticket, input.category);
    drawTimeline(doc, input.milestones);
    drawResolutionText(doc, ticket.resolution);
    drawIdentityVerification(doc, input.identityVerification);
    drawCorrespondence(doc, input.detail);
    drawEscalations(doc, input.detail);

    drawPageNumbers(doc);
    doc.end();
  });
}

function drawSummary(
  doc: PDFKit.PDFDocument,
  ticket: RequestDetail['ticket'],
  category: GrievanceCategory | null,
) {
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Complaint summary');
  doc.moveDown(0.2);
  labelValue(doc, 'Reference', ticket.referenceCode);
  labelValue(doc, 'Category', category ? GRIEVANCE_CATEGORY_LABELS[category] : 'Not categorised');
  labelValue(doc, 'Subject', ticket.subject);
  labelValue(doc, 'Contact', `${ticket.contactChannel} — ${ticket.contactValue}`);
  labelValue(doc, 'Status', ticket.status.replace(/_/g, ' '));
  labelValue(doc, 'Escalation level reached', String(ticket.escalationLevel));
  doc.moveDown(0.4);
  drawRule(doc);
  doc.moveDown(0.4);
}

function drawTimeline(doc: PDFKit.PDFDocument, m: GrievanceMilestones) {
  ensureSpace(doc, 160);
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Timeline');
  doc.moveDown(0.2);

  labelValue(doc, 'Received', formatTimestamp(m.receivedAt));
  labelValue(doc, 'Contact verified', formatTimestamp(m.verifiedAt));
  labelValue(doc, 'First actioned by staff', formatTimestamp(m.actionedAt));
  labelValue(doc, 'Closed', formatTimestamp(m.closedAt));
  labelValue(doc, 'Response due by (SLA)', formatTimestamp(m.slaDueAt));

  doc.moveDown(0.3);
  const { text, color } = complianceLine(m);
  doc.fontSize(10.5).fillColor(color).font('Helvetica-Bold').text(text);
  doc.moveDown(0.4);
  drawRule(doc);
  doc.moveDown(0.4);
}

function complianceLine(m: GrievanceMilestones): { text: string; color: string } {
  if (m.withinSla === null) {
    return { text: 'SLA compliance: not applicable — no SLA deadline was recorded for this ticket.', color: '#666' };
  }
  if (!m.closedAt || !m.slaDueAt) {
    return { text: 'SLA compliance: not applicable.', color: '#666' };
  }
  const deltaMs = new Date(m.closedAt).getTime() - new Date(m.slaDueAt).getTime();
  if (m.withinSla) {
    return {
      text: `Resolved within the required time — ${formatDuration(-deltaMs)} before the SLA deadline.`,
      color: '#067647',
    };
  }
  return {
    text: `Resolved ${formatDuration(deltaMs)} after the SLA deadline.`,
    color: '#b42318',
  };
}

function drawResolutionText(doc: PDFKit.PDFDocument, resolution: string | null) {
  ensureSpace(doc, 80);
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Resolution');
  doc.moveDown(0.2);
  doc
    .fontSize(9.5)
    .fillColor('#222')
    .font('Helvetica')
    .text(resolution ?? 'No resolution summary was recorded.', { width: CONTENT_WIDTH });
  doc.moveDown(0.4);
  drawRule(doc);
  doc.moveDown(0.4);
}

function drawIdentityVerification(doc: PDFKit.PDFDocument, iv: IdentityVerificationSummary) {
  ensureSpace(doc, 100);
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Identity verification (FR-GRV-04)');
  doc.moveDown(0.2);

  if (!iv.outcome) {
    doc.fontSize(9.5).fillColor('#999').font('Helvetica-Oblique').text('No completed identity verification is on record.');
  } else {
    labelValue(doc, 'Outcome', iv.outcome);
    labelValue(doc, 'Recorded reason', iv.reason ?? '(none recorded)');
    labelValue(doc, 'Completed', formatTimestamp(iv.occurredAt));
  }
  doc.moveDown(0.4);
  drawRule(doc);
  doc.moveDown(0.4);
}

function drawCorrespondence(doc: PDFKit.PDFDocument, detail: RequestDetail) {
  ensureSpace(doc, 60);
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Correspondence trail');
  doc.moveDown(0.2);

  if (detail.correspondence.length === 0) {
    doc.fontSize(9.5).fillColor('#999').font('Helvetica-Oblique').text('No correspondence recorded.');
  }
  for (const entry of detail.correspondence) {
    ensureSpace(doc, 50);
    const who = correspondenceLabel(entry);
    doc.fontSize(8.5).fillColor('#888').font('Helvetica-Bold').text(`${who} — ${formatTimestamp(entry.createdAt)}`);
    doc.fontSize(9.5).fillColor('#222').font('Helvetica').text(entry.body, { width: CONTENT_WIDTH });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.2);
  drawRule(doc);
  doc.moveDown(0.4);
}

function correspondenceLabel(entry: RequestDetail['correspondence'][number]): string {
  if (entry.direction === 'internal_note') return 'Internal note (staff)';
  if (entry.authorType === 'public_submitter') return 'Requester';
  if (entry.authorType === 'system') return 'System';
  return 'Organisation (staff)';
}

function drawEscalations(doc: PDFKit.PDFDocument, detail: RequestDetail) {
  ensureSpace(doc, 60);
  doc.fontSize(12).fillColor('#111').font('Helvetica-Bold').text('Escalation ladder — rungs reached');
  doc.moveDown(0.2);

  if (detail.escalations.length === 0) {
    doc.fontSize(9.5).fillColor('#999').font('Helvetica-Oblique').text('No escalation was triggered.');
    return;
  }
  for (const e of detail.escalations) {
    ensureSpace(doc, 30);
    labelValue(
      doc,
      `Level ${e.level} — ${e.rung.replace(/_/g, ' ')}`,
      `${e.trigger.replace(/_/g, ' ')} at ${formatTimestamp(e.occurredAt)}${e.reason ? ` — ${e.reason}` : ''}`,
    );
  }
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '(not recorded)';
}

/** Whole hours/minutes, always non-negative — callers pass an already-signed delta. */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((abs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
