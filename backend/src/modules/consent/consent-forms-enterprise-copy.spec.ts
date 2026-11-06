import { ConsentFormsService } from './consent-forms.service';

/**
 * ConsentFormsService.submit() with Enterprise copies — the hosted-link case:
 * the CUSTOMER's browser has no filesystem access at all and sends only the
 * field values; the consent is recorded first and never depends on any
 * storage outcome; Central DPDP Storage behaves exactly as before; the
 * Enterprise copy is queued in addition, from the tenant's own mappings.
 * Collaborators are stubs recording what they were asked to do.
 */

const FORM = 'form-1';
const FIELD_EMAIL = 'field-email';
const FIELD_PROOF = 'field-proof';

function build(opts: { serverWriteSucceeds: boolean | null; enterpriseQueued?: number }) {
  const calls = {
    recordConsent: jest.fn(async () => ({ receipt: { eventId: 'event-1' } })),
    stage: jest.fn(async () => undefined),
    stageEnterpriseCopies: jest.fn(async () => opts.enterpriseQueued ?? 1),
    writeNow: jest.fn(async () => ({ success: opts.serverWriteSucceeds === true })),
    markSynced: jest.fn(async () => true),
    annotate: jest.fn(),
  };
  const repo = {
    getForm: async () => ({ id: FORM, name: 'KYC', is_active: true, retention_months: null }),
    listRows: async () => [{ consent_purpose_id: 'p1', notice_version_id: 'n1' }],
    listCustomerFields: async () => [
      { id: FIELD_EMAIL, label: 'Email' },
      { id: FIELD_PROOF, label: 'ID proof' },
    ],
    createSubmission: async () => ({ id: 'sub-1' }),
    markSubmissionSynced: calls.markSynced,
  };
  const svc = new ConsentFormsService(
    repo as never,
    { recordConsent: calls.recordConsent } as never,
    {} as never,
    { hash: async () => 'subject-ref' } as never,
    {} as never,
    {} as never,
    { resolve: async () => ({ customerId: 'cust-1', displayName: 'Asha' }) } as never,
    {
      // null = no 'server' root configured (the SaaS / Gateway case).
      writeSubmissionFieldsNow: opts.serverWriteSucceeds === null ? async () => ({ success: false }) : calls.writeNow,
      hasActiveServerRoot: async () => opts.serverWriteSucceeds !== null,
    } as never,
    { stage: calls.stage, stageEnterpriseCopies: calls.stageEnterpriseCopies } as never,
    { getOrThrow: () => ({ tenantId: 't', userId: 'u' }) } as never,
    { annotate: calls.annotate } as never,
  );
  return { svc, calls };
}

const submit = (svc: ConsentFormsService) =>
  svc.submitLink(FORM, {
    identityValue: 'asha@example.com',
    customerNameValue: 'Asha',
    answers: [{ consentPurposeId: 'p1', granted: true }],
    fieldValues: [
      { fieldId: FIELD_EMAIL, textValue: 'asha@example.com' },
      { fieldId: FIELD_PROOF, file: { filename: 'scan.pdf', contentBase64: 'JVBERg==' } },
      { fieldId: 'not-on-this-form', textValue: 'dropped' },
    ],
  } as never);

describe('submit() — Enterprise copies are additional; consent and Central storage are unchanged', () => {
  it('hosted link, no server root: consent recorded, Central relay staged as before, Enterprise copy queued too', async () => {
    const { svc, calls } = build({ serverWriteSucceeds: null });
    const r = await submit(svc);
    expect(r.answers).toEqual([{ consentPurposeId: 'p1', granted: true }]);
    expect(calls.recordConsent).toHaveBeenCalledTimes(1);
    expect(calls.stage).toHaveBeenCalledTimes(1);
    expect(calls.stageEnterpriseCopies).toHaveBeenCalledWith({
      submissionId: 'sub-1',
      formId: FORM,
      // Only fields still on the form, keyed by id — no destination, no path:
      // the destination is resolved from the tenant's own mappings.
      fields: [
        { fieldId: FIELD_EMAIL, label: 'Email', textValue: 'asha@example.com' },
        // `extension` is the one PROVED from the bytes, and it decides the
        // stored filename. Null here because this stub's field carries no
        // field_type, so the byte check does not apply to it — a real `file`
        // or `pdf` field carries the proved extension instead of the
        // respondent's own (see consent-form-uploads.spec.ts).
        {
          fieldId: FIELD_PROOF,
          label: 'ID proof',
          file: { filename: 'scan.pdf', contentBase64: 'JVBERg==', extension: null },
        },
      ],
    });
  });

  it('Central written synchronously (server root): no Central relay, but the Enterprise copy is still queued', async () => {
    const { svc, calls } = build({ serverWriteSucceeds: true });
    await submit(svc);
    expect(calls.markSynced).toHaveBeenCalled();
    expect(calls.stage).not.toHaveBeenCalled();
    expect(calls.stageEnterpriseCopies).toHaveBeenCalledTimes(1);
  });

  it('Central write failed: Central relay staged (unchanged), Enterprise copy queued independently, consent still recorded', async () => {
    const { svc, calls } = build({ serverWriteSucceeds: false });
    const r = await submit(svc);
    expect(calls.markSynced).not.toHaveBeenCalled();
    expect(calls.stage).toHaveBeenCalledTimes(1);
    expect(calls.stageEnterpriseCopies).toHaveBeenCalledTimes(1);
    expect(r.submissionId).toBe('sub-1');
  });

  it('nothing to copy (no mapped Gateway folder): the submission is identical, and the audit records no copy', async () => {
    const { svc, calls } = build({ serverWriteSucceeds: null, enterpriseQueued: 0 });
    await submit(svc);
    const annotation = calls.annotate.mock.calls[0]![0] as { afterState: Record<string, unknown> };
    expect(annotation.afterState).not.toHaveProperty('enterpriseCopiesQueued');
  });

  it('the audit entry counts queued copies, never a value or a path', async () => {
    const { svc, calls } = build({ serverWriteSucceeds: null, enterpriseQueued: 2 });
    await submit(svc);
    const annotation = calls.annotate.mock.calls[0]![0] as { afterState: Record<string, unknown> };
    expect(annotation.afterState.enterpriseCopiesQueued).toBe(2);
    expect(JSON.stringify(annotation)).not.toContain('asha@example.com');
  });
});
