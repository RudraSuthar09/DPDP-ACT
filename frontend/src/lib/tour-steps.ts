import { apiFetch } from './api';

/**
 * The guided tour's script.
 *
 * Two rules shape every step below.
 *
 * ONE — it points at a REAL screen. There are no mock screenshots and no
 * illustrated stand-ins: each step navigates to the route it is describing and
 * highlights an element that is actually on it. A tour of a pretend product
 * teaches you the pretend product.
 *
 * TWO — it uses the tenant's OWN data as the example. A CA/tax practice that
 * applied the sector template (Prompt 38) already has Aadhaar Card, PAN Card,
 * Bank Account Details and Date of Birth in its register, with the office
 * WhatsApp, office email, client portal and document server behind them. The
 * copy names those things because the reader is looking straight at them —
 * so the tour and the product agree, and nothing has to be un-learned later.
 *
 * The language is deliberately plain: the reader is a chartered accountant, not
 * a data-protection lawyer, and every sentence here is one they could repeat to
 * a client without translating it first.
 */
export interface TourStep {
  id: string;
  title: string;
  /** Plain-language paragraphs. */
  body: string[];
  /** The real route this step is about. */
  href: string;
  /**
   * CSS selector for the element to highlight on that route. If it never
   * appears (a slow load, or a role that cannot see that panel), the step still
   * shows — centred, without a ring — rather than blocking the tour.
   */
  anchor: string;
  /**
   * Optional selector that must ALSO be present before the step is considered
   * ready. The anchor is often a panel shell that renders immediately and fills
   * with data a moment later — highlighting it in between points the reader at
   * an empty box while the copy talks about its contents. Naming the innermost
   * thing the step is really about closes that gap.
   */
  waitFor?: string;
  /**
   * Steps whose route depends on the tenant's own data resolve it at run time.
   * Returning null keeps the static `href`.
   */
  resolveHref?: () => Promise<string | null>;
}

/** Shape of the bit of GET /inventory we need to find a real element to open. */
interface InventoryListResponse {
  elements: Array<{ id: string; category: string }>;
}

/**
 * The retention step wants a real data element open, because retention is
 * recorded per purpose ON an element — there is no standalone "retention
 * screen" and inventing one for the tour would be a lie about the product.
 * Prefers a document type the CA template seeds so the copy matches what is on
 * screen; falls back to whatever the tenant does have, then to the register.
 */
async function resolveRetentionHref(): Promise<string | null> {
  try {
    const res = await apiFetch<InventoryListResponse>('/inventory/register');
    const preferred =
      res.elements.find((e) => /^PAN Card/i.test(e.category)) ??
      res.elements.find((e) => /^Aadhaar/i.test(e.category)) ??
      res.elements[0];
    return preferred ? `/inventory/${preferred.id}` : null;
  } catch {
    return null;
  }
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'dashboard',
    title: 'Everything at a glance',
    body: [
      'This is your home screen. It answers one question: where do things stand right now?',
      'The tiles count what you actually have on record — data categories, consents, open complaints and requests. Underneath, recent activity shows what has happened lately and who did it.',
      'If you only ever open one screen, open this one.',
    ],
    href: '/dashboard',
    anchor: '[data-tour="dashboard-stats"]',
  },
  {
    id: 'inventory',
    title: 'What you collect, and why',
    body: [
      'This is your record of the personal documents your practice handles — the single question a regulator asks first.',
      'Aadhaar, PAN, bank details and date of birth are already here as a starting point, taken from a standard KYC process. Each one says what it is, where it is kept, and which engagement it was collected for — ITR filing, GST registration, TAN/TDS, and so on.',
      'Nothing here is fixed. Edit any of it, delete what you do not collect, add whatever you do. Every change is kept as a new version, so you can always show what the record said last March.',
    ],
    href: '/inventory',
    anchor: '[data-tour="inventory-register"]',
  },
  {
    id: 'systems-vendors',
    title: 'Where documents arrive, and who else sees them',
    body: [
      'Documents reach you somehow, and sometimes they have to go somewhere else. Both halves belong on the record.',
      'Systems are the places documents come in and sit: your office WhatsApp number, the office email, a client portal, your document server. Each one can record who in the firm is allowed to open it — "staff on the assignment only, need-to-know basis".',
      'Vendors are everyone else who receives a document: the Income Tax Portal, the GST Portal, a client\'s bank. Use the Vendors tab beside this one.',
    ],
    href: '/inventory/systems',
    anchor: '[data-tour="systems-register"]',
  },
  {
    id: 'retention',
    title: 'How long you keep each document',
    body: [
      'Open any document type and you will see the engagements it was collected for, and beside each one, how long it is kept.',
      'We have filled in a starting figure for each — eight years from the assessment year for an ITR filing, six from the financial year for GST, and so on.',
      'Treat these as a prompt, not an answer. Check each against the statutory period that actually applies to that filing, and correct it here. Every one of them is labelled "indicative" until you do.',
    ],
    href: '/inventory',
    anchor: '[data-tour="purposes-panel"]',
    // The panel shell renders before its purposes arrive; without this the ring
    // can land on an empty box while the copy describes retention values.
    waitFor: '[data-testid="purpose-row"]',
    resolveHref: resolveRetentionHref,
  },
  {
    id: 'consent',
    title: 'Telling clients what you hold',
    body: [
      'Where you rely on a client agreeing to something, rather than on your engagement letter or on the law, this is where that lives.',
      'You write the notice once — plain language, in as many languages as your clients read — and the register keeps a dated record of who was shown which version, and when.',
      'For a lot of tax work your engagement letter is the basis and you will barely touch this. It is here for the times you need it.',
    ],
    href: '/consent',
    anchor: '[data-tour="consent-main"]',
  },
  {
    id: 'portal',
    title: 'A page to share with your own clients',
    body: [
      'Your practice has its own public page, on the link shown here. Share it with your clients however you already talk to them.',
      'If a client wants to know what you hold about them, wants something corrected, or wants to complain, they use that page — and it arrives here as a tracked request with a reference number and a clock running against the legal deadline.',
      'It means you never have to build a process for this. You already have one.',
    ],
    href: '/grievance',
    anchor: '[data-tour="portal-link"]',
  },
  {
    id: 'audit',
    title: 'Your proof, ready whenever it is asked for',
    body: [
      'Every change anyone makes is written here permanently — who, what, when — in a form that cannot be quietly edited afterwards. "Verify chain" checks that for you and says so.',
      'When a client, an auditor or a regulator asks how you handle documents, you do not have to assemble anything. Export the evidence bundle from the Dashboard and hand it over.',
      'This is the part that turns "we are careful" into something you can actually show.',
    ],
    href: '/audit',
    anchor: '[data-tour="audit-main"]',
  },
  {
    id: 'closing',
    title: 'One last thing, and it matters',
    body: [
      'Your clients\' actual documents stay on your own systems. We never hold a scan of an Aadhaar card, a PAN copy, or a bank statement — and there is no way for us to.',
      'What we hold is the record that proves you are handling them properly: what you collect, why, where it lives, who you share it with, how long you keep it, and everything anyone did about it.',
      'That is the whole idea. Your files stay yours; the proof lives here.',
    ],
    href: '/dashboard',
    anchor: '[data-tour="dashboard-stats"]',
  },
];
