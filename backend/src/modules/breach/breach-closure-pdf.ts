import PDFDocument from 'pdfkit';
import {
  BREACH_GATES,
  BREACH_GATE_LABELS,
  type BreachIncidentDetail,
} from '@dpdp/shared';
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
 * FR-BRC-07 — the sealed closure packet.
 *
 * Same pdfkit pipeline as the RoPA (FR-INV-09), the proof-of-consent
 * certificate (FR-CON-08), the grievance resolution export (FR-GRV-06) and the
 * DPR register (FR-DPR-06): same layout helpers, same branding, same page
 * numbering. Five documents, one PDF system.
 *
 * "SEALED" MEANS THE PACKET STATES ITS OWN INTEGRITY, not that it is encrypted.
 * The packet lists every gate with who passed it and when, every escalation
 * that fired, and every piece of evidence by SHA-256. Anyone holding the
 * original files can recompute those digests and prove the packet describes
 * the same evidence that was submitted at the time — which is what an
 * investigation actually needs, and is achievable without the platform ever
 * having stored the files themselves (I1).
 *
 * WHAT IT DOES NOT CONTAIN: any affected person. There is no recipient list in
 * the register to print, by design. The packet reports a COUNT and the fact
 * that notification happened.
 */
export function renderClosurePacketPdf(input: {
  organisationName: string;
  generatedAt: Date;
  detail: BreachIncidentDetail;
}): Promise<Buffer> {
  const { incident, dataCategories, gateEvents, gateStatuses, evidence, escalations } = input.detail;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const onTime = gateStatuses.filter((g) => g.completedOnTime === true).length;
    const completed = gateStatuses.filter((g) => g.completedAt !== null).length;

    drawBrandedCoverHeader(doc, {
      orgName: input.organisationName,
      title: 'Breach Incident Closure Packet',
      subtitle:
        `Incident ${incident.referenceCode}. Generated ${input.generatedAt.toLocaleString()}. ` +
        `${completed} of ${BREACH_GATES.length} workflow gates completed, ${onTime} within their ` +
        'deadline. Deadlines are the versioned policy records that were in force when this ' +
        'incident was opened (FR-BRC-02) — not figures applied retrospectively.',
    });

    doc.moveDown(0.3);
    labelValue(doc, 'Title', incident.title);
    labelValue(doc, 'Severity', incident.severity);
    labelValue(doc, 'Discovered', new Date(incident.discoveredAt).toUTCString());
    if (incident.occurredAt) labelValue(doc, 'Occurred', new Date(incident.occurredAt).toUTCString());
    labelValue(
      doc,
      'Data Principals affected',
      incident.estimatedAffectedCount !== null ? `approximately ${incident.estimatedAffectedCount}` : 'not estimated',
    );
    labelValue(doc, 'Systems affected', incident.systemsAffected.join(', ') || 'none recorded');
    labelValue(doc, 'Status', incident.status);
    if (incident.closedAt) labelValue(doc, 'Closed', new Date(incident.closedAt).toUTCString());

    section(doc, 'What happened');
    body(doc, incident.whatHappened);

    section(doc, 'Data categories involved');
    if (dataCategories.length === 0) {
      body(doc, 'No Data Inventory categories were linked to this incident.');
    } else {
      for (const c of dataCategories) {
        ensureSpace(doc, 40);
        doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#222').text(c.category);
        doc.fontSize(9).font('Helvetica').fillColor('#444')
          .text(`Held in ${c.storageLocation}`, { width: CONTENT_WIDTH });
        for (const p of c.purposes) {
          doc.text(
            `    ${p.purposeName} — ${p.legalBasis.replace(/_/g, ' ')}, retained ${p.retentionPeriod}`,
            { width: CONTENT_WIDTH },
          );
        }
        doc.moveDown(0.3);
      }
    }

    section(doc, 'Workflow gates');
    for (const gate of BREACH_GATES) {
      const status = gateStatuses.find((g) => g.gate === gate);
      const event = gateEvents.find((g) => g.gate === gate);
      ensureSpace(doc, 44);
      const verdict = !status?.completedAt
        ? status?.overdue
          ? 'NOT COMPLETED — past deadline'
          : 'not completed'
        : status.completedOnTime
          ? 'completed within deadline'
          : 'completed LATE';
      doc.fontSize(9.5).font('Helvetica-Bold')
        .fillColor(status?.completedOnTime === false || status?.overdue ? '#b3261e' : '#1a7f37')
        .text(`${BREACH_GATE_LABELS[gate]} — ${verdict}`);
      doc.fontSize(8.5).font('Helvetica').fillColor('#555').text(
        `Deadline ${status?.dueAt ? new Date(status.dueAt).toUTCString() : '—'}` +
          (status?.policyVersion ? `  (${status.policyKey} v${status.policyVersion})` : '') +
          (event ? `   Completed ${new Date(event.completedAt).toUTCString()}` : ''),
        { width: CONTENT_WIDTH },
      );
      if (event?.notes) {
        doc.fontSize(9).fillColor('#222').text(event.notes, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.35);
    }

    section(doc, 'Evidence submitted');
    if (evidence.length === 0) {
      body(doc, 'No evidence was registered against this incident.');
    } else {
      body(
        doc,
        'The platform records a SHA-256 of each file submitted and never retains the file itself. ' +
          'Recompute these digests against the originals to prove they are the same bytes.',
      );
      for (const e of evidence) {
        ensureSpace(doc, 34);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#222').text(e.fileName);
        doc.fontSize(8).font('Courier').fillColor('#444').text(e.sha256, { width: CONTENT_WIDTH });
        doc.fontSize(8.5).font('Helvetica').fillColor('#555').text(
          `${e.sizeBytes} bytes · ${e.contentType ?? 'unknown type'} · submitted ${new Date(e.uploadedAt).toUTCString()}` +
            (e.description ? ` · ${e.description}` : ''),
          { width: CONTENT_WIDTH },
        );
        doc.moveDown(0.3);
      }
    }

    section(doc, 'Escalations raised');
    if (escalations.length === 0) {
      body(doc, 'No deadline escalation was raised on this incident.');
    } else {
      for (const e of escalations) {
        ensureSpace(doc, 26);
        doc.fontSize(8.5).font('Helvetica').fillColor('#222').text(
          `${new Date(e.occurredAt).toUTCString()} — ${e.gate.replace(/_/g, ' ')} level ${e.level} ` +
            `(${e.rung.replace(/_/g, ' ')}, ${e.trigger}) — ` +
            (e.notifiedOk ? `notified ${e.notifiedContact}` : 'no active holder to notify'),
          { width: CONTENT_WIDTH },
        );
      }
    }

    if (incident.closureNote) {
      section(doc, 'Closure sign-off');
      body(doc, incident.closureNote);
    }

    doc.moveDown(0.8);
    drawRule(doc);
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#666').text(
      'This packet is generated fresh from the incident register on every request and is never stored. ' +
        'Gate completion is judged against the deadline recorded when this incident was opened, never ' +
        'against a policy adopted afterwards. Evidence is attested by digest: the platform holds the ' +
        'SHA-256, not the file, because breach evidence is the likeliest material in the product to ' +
        'contain personal data. No affected Data Principal is named anywhere in this document.',
      MARGIN,
      doc.y,
      { width: CONTENT_WIDTH },
    );

    drawPageNumbers(doc);
    doc.end();
  });
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 50);
  doc.moveDown(0.6);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(title);
  drawRule(doc);
  doc.moveDown(0.25);
}

function body(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(9.5).font('Helvetica').fillColor('#222').text(text, { width: CONTENT_WIDTH });
}
