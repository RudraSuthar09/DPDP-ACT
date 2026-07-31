import type {
  BreachDataCategory,
  BreachGateEvent,
  BreachIncident,
  BreachTemplate,
  BreachTemplateKind,
} from '@dpdp/shared';

/**
 * FR-BRC-06 — the two notification texts, auto-populated from the incident's
 * REAL data: its own narrative, the Data Inventory entries it references (with
 * their live purposes and legal bases), the assessment recorded at the `assess`
 * gate, and the remediation recorded at `remediate`.
 *
 * ===========================================================================
 * TWO THINGS THESE TEMPLATES DELIBERATELY DO NOT DO.
 *
 * They do not address anyone. There is no recipient list, no mail merge, no
 * "Dear {{name}}" — the platform holds no affected-person list and never will
 * (I1). What it produces is the TEXT; putting it in front of the right people
 * is the client's job, from the client's own records, exactly as Tier 2 of the
 * Personal Data Summary works.
 *
 * They do not invent facts. Where the incident has no answer yet — no
 * assessment recorded, no remediation described — the template says so in
 * square brackets AND reports it in `gaps`, rather than emitting fluent prose
 * that reads as complete. A regulator notice that silently papers over an
 * unfinished assessment is worse than no draft at all: it is a document
 * somebody might send.
 * ===========================================================================
 */
export function renderTemplate(
  kind: BreachTemplateKind,
  input: {
    organisationName: string;
    incident: BreachIncident;
    categories: BreachDataCategory[];
    gateEvents: BreachGateEvent[];
  },
): BreachTemplate {
  const gaps: string[] = [];
  const noteFor = (gate: string) => input.gateEvents.find((g) => g.gate === gate)?.notes ?? null;

  const assessment = noteFor('assess');
  if (!assessment) gaps.push('The assessment gate has not been completed — scope and impact are unstated.');
  const remediation = noteFor('remediate');
  if (!remediation) gaps.push('No remediation has been recorded yet.');
  const rootCause = noteFor('rca');
  if (!rootCause) gaps.push('No root-cause analysis has been recorded yet.');
  if (input.categories.length === 0) {
    gaps.push('No Data Inventory categories are linked to this incident.');
  }
  if (input.incident.estimatedAffectedCount === null) {
    gaps.push('The estimated number of affected Data Principals has not been set.');
  }

  const categoryLines = input.categories.length
    ? input.categories
        .map((c) => {
          const bases = [...new Set(c.purposes.map((p) => p.legalBasis.replace(/_/g, ' ')))];
          return `  • ${c.category} (held in ${c.storageLocation}` +
            (bases.length ? `; processed on the basis of ${bases.join(', ')}` : '') +
            ')';
        })
        .join('\n')
    : '  • [No data categories have been linked to this incident yet.]';

  const affected =
    input.incident.estimatedAffectedCount !== null
      ? `approximately ${input.incident.estimatedAffectedCount}`
      : '[not yet estimated]';

  if (kind === 'data_principal_notice') {
    return {
      kind,
      title: `Notice of a personal data breach — ${input.incident.referenceCode}`,
      gaps,
      body: [
        `${input.organisationName} is writing to tell you about a personal data breach that may affect you.`,
        '',
        'WHAT HAPPENED',
        input.incident.whatHappened,
        '',
        `We became aware of this on ${fmt(input.incident.discoveredAt)}.`,
        '',
        'WHAT INFORMATION WAS INVOLVED',
        categoryLines,
        '',
        'WHAT WE HAVE DONE',
        remediation ?? '[Remediation is still in progress. This section must be completed before sending.]',
        '',
        'WHAT YOU CAN DO',
        'If you notice anything unusual on your account, contact us using the details below. You may also',
        'lodge a complaint with us, and with the Data Protection Board of India.',
        '',
        'HOW TO REACH US',
        `Contact the Data Protection Officer at ${input.organisationName}.`,
        '',
        `Reference: ${input.incident.referenceCode}`,
      ].join('\n'),
    };
  }

  return {
    kind,
    title: `Personal data breach report to the Data Protection Board — ${input.incident.referenceCode}`,
    gaps,
    body: [
      `REPORT OF A PERSONAL DATA BREACH`,
      `Submitted by: ${input.organisationName}`,
      `Reference:    ${input.incident.referenceCode}`,
      `Reported under section 8(6) of the Digital Personal Data Protection Act, 2023.`,
      '',
      '1. NATURE OF THE BREACH',
      input.incident.whatHappened,
      `Severity assessed as: ${input.incident.severity}.`,
      '',
      '2. TIMING',
      `Discovered:  ${fmt(input.incident.discoveredAt)}`,
      `Occurred:    ${input.incident.occurredAt ? fmt(input.incident.occurredAt) : '[not established]'}`,
      '',
      '3. CATEGORIES OF PERSONAL DATA INVOLVED',
      categoryLines,
      '',
      '4. SYSTEMS AFFECTED',
      input.incident.systemsAffected.length
        ? input.incident.systemsAffected.map((s) => `  • ${s}`).join('\n')
        : '  • [None recorded.]',
      '',
      '5. SCOPE',
      `Data Principals affected: ${affected}.`,
      '',
      '6. ASSESSMENT',
      assessment ?? '[The assessment gate has not been completed.]',
      '',
      '7. MITIGATION AND REMEDIATION',
      remediation ?? '[No remediation recorded yet.]',
      '',
      '8. ROOT CAUSE',
      rootCause ?? '[No root-cause analysis recorded yet.]',
      '',
      '9. NOTIFICATION OF DATA PRINCIPALS',
      noteFor('notify_data_principals') ?? '[Data Principals have not yet been notified.]',
    ].join('\n'),
  };
}

function fmt(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
