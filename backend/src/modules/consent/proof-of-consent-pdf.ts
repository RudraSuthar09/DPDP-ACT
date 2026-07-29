import PDFDocument from 'pdfkit';
import { noticeLanguageLabel, type NoticeLanguageCode } from '@dpdp/shared';
import {
  CONTENT_WIDTH,
  MARGIN,
  drawBrandedCoverHeader,
  drawPageNumbers,
  drawRule,
  ensureSpace,
  labelValue,
} from '../../pdf/pdfkit-layout';
import type { ConsentEventRow } from './consent.repository';

/**
 * FR-CON-08 — the proof-of-consent certificate. Same pdfkit pipeline as the
 * RoPA export (FR-INV-09): same layout helpers (`pdf/pdfkit-layout.ts`), same
 * branding (the tenant's organisation name — the only branding field that
 * exists), same page-numbering workaround. One PDF system, two documents.
 *
 * What makes this a CERTIFICATE rather than just a rendered row: it resolves
 * `notice_version_id` to the exact notice text the subject was shown (every
 * published language, not just one — the certificate cannot know which
 * language they were actually shown, so it shows all of them), and it states
 * the two-clock question being answered in the same plain English the Prompt
 * 21 timeline UI uses, so a reader cannot mistake "what we now believe was
 * true then" for "what we could honestly have said back then".
 */
export function renderProofOfConsentPdf(input: {
  organisationName: string;
  generatedAt: Date;
  subjectRef: string;
  purposeName: string;
  event: ConsentEventRow;
  asOf: string;
  knownAs: string;
  noticeTranslations: { language: NoticeLanguageCode; body: string }[];
  noticeVersionNumber: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawBrandedCoverHeader(doc, {
      orgName: input.organisationName,
      title: 'Proof of Consent Certificate',
      subtitle:
        `Generated ${input.generatedAt.toLocaleString()}. ${clockSentence(input.asOf, input.knownAs)} ` +
        'Derived from the append-only consent register (FR-CON-05/08) — never a cached or ' +
        'hand-edited record.',
    });

    doc.moveDown(0.3);
    labelValue(doc, 'Subject reference', input.subjectRef);
    labelValue(doc, 'Purpose', input.purposeName);
    doc.moveDown(0.4);

    doc.fontSize(9.5).fillColor('#333').font('Helvetica-Bold').text('Consent status');
    doc.moveDown(0.15);
    const statusColor = input.event.status === 'GRANTED' ? '#067647' : input.event.status === 'WITHDRAWN' ? '#b42318' : '#666';
    doc.fontSize(13).fillColor(statusColor).font('Helvetica-Bold').text(input.event.status);
    doc.moveDown(0.3);

    labelValue(doc, 'Occurred at (valid time)', input.event.occurred_at.toLocaleString());
    labelValue(doc, 'Recorded at (transaction time)', input.event.recorded_at.toLocaleString());
    labelValue(doc, 'Source', sourceLabel(input.event.source));
    doc.moveDown(0.2);

    doc.fontSize(9.5).fillColor('#333').font('Helvetica-Bold').text('Evidence hash');
    doc.moveDown(0.1);
    doc.fontSize(9).fillColor('#222').font('Courier').text(input.event.evidence_hash);
    doc
      .fontSize(8.5)
      .fillColor('#666')
      .font('Helvetica-Oblique')
      .text(
        input.event.evidence_hash_origin === 'client'
          ? "Client-attested: the client's own seal over evidence they hold (the rendered notice, the " +
              'form state). The platform recorded this hash; it did not compute it.'
          : "Platform-derived: the platform's canonical digest over exactly what was recorded, because " +
              'the ingest payload supplied no hash of its own.',
      );
    doc.moveDown(0.5);

    drawRule(doc);
    doc.moveDown(0.4);

    doc
      .fontSize(11)
      .fillColor('#111')
      .font('Helvetica-Bold')
      .text(`Notice shown (version ${input.noticeVersionNumber})`);
    doc
      .fontSize(8.5)
      .fillColor('#666')
      .font('Helvetica')
      .text(
        'The exact text the data principal was shown before this consent was given, in every ' +
          'language it was published in (FR-CON-02). This certificate cannot know which language ' +
          'the subject was actually shown, so every published translation follows.',
      );
    doc.moveDown(0.3);

    for (const t of input.noticeTranslations) {
      ensureSpace(doc, 60);
      doc
        .fontSize(9)
        .fillColor('#333')
        .font('Helvetica-Bold')
        .text(noticeLanguageLabel(t.language));
      doc.moveDown(0.1);
      doc.fontSize(9.5).fillColor('#222').font('Helvetica').text(t.body, { width: CONTENT_WIDTH });
      doc.moveDown(0.35);
    }

    drawPageNumbers(doc);
    doc.end();
  });
}

/** The same anti-conflation sentence Prompt 21's timeline UI shows — a
 *  certificate that silently picked one meaning would misrepresent what
 *  bitemporal storage actually answers. */
function clockSentence(asOf: string, knownAs: string): string {
  const asOfDate = new Date(asOf).toLocaleDateString();
  const knownAsDate = new Date(knownAs).toLocaleDateString();
  if (asOf === knownAs) {
    return `This certificate states what was believed true on ${asOfDate}, using only what had been recorded by that same date.`;
  }
  return (
    `This certificate states what is NOW believed to have been true on ${asOfDate}, ` +
    `using everything recorded up to ${knownAsDate} — including any correction filed after ${asOfDate} itself.`
  );
}

function sourceLabel(source: string): string {
  if (source === 'internal') {
    return 'Platform (one-click withdrawal on the subject’s behalf)';
  }
  return source;
}
