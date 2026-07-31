import type { PurposeLinkSuggestion } from '@dpdp/shared';
import type { LinkCandidateRow } from './purpose-links.repository';

/**
 * Score how likely a consent purpose and an inventory purpose describe the same
 * processing (FR-DPR-04).
 *
 * READ THIS BEFORE TRUSTING A NUMBER OUT OF HERE. The only signal available is
 * the two names a human typed into two different registers, months apart. That
 * is a weak signal and this file does not pretend otherwise: the score is token
 * overlap, the reason string says exactly what matched, and NOTHING in the
 * platform acts on the output. A suggestion becomes a link only when a person
 * accepts it, and only accepted links reach a data principal's summary.
 *
 * That is the same arrangement `pii-classifier.ts` already uses for PII
 * category suggestions, deliberately: a confidence-scored hint, a visible
 * reason, and a human decision recorded separately from the machine's guess.
 * The alternative — quietly joining on name at read time — puts the guess into
 * a statutory document with nobody's name against it.
 */

const SUGGESTION_FLOOR = 0.35;

/** Words that carry no discriminating signal between two purpose names. Without
 *  this, "Customer data processing" and "Marketing data processing" score 0.66
 *  on the strength of two words that appear in half the register. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'data', 'personal', 'information', 'processing', 'purpose', 'purposes',
  'customer', 'user', 'service', 'services',
]);

function tokenise(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Jaccard overlap of the significant tokens, with an exact-name shortcut.
 *
 * Jaccard rather than "how many of A's words appear in B", because the
 * asymmetric version scores a one-word purpose against a five-word one as a
 * perfect match — "Billing" would match "Billing, fraud and credit scoring" at
 * 1.0, and those are not the same processing.
 */
export function scoreCandidate(consentName: string, inventoryName: string): { score: number; reason: string } {
  const a = consentName.trim().toLowerCase();
  const b = inventoryName.trim().toLowerCase();
  if (a === b && a.length > 0) {
    return { score: 1, reason: 'The two purpose names are identical.' };
  }

  const ta = tokenise(consentName);
  const tb = tokenise(inventoryName);
  if (ta.size === 0 || tb.size === 0) {
    // Every significant word was a stop word, so the names are things like
    // "Customer data" on both sides. That is not evidence of anything.
    return { score: 0, reason: 'No distinguishing words in common.' };
  }

  const shared = [...ta].filter((t) => tb.has(t));
  const union = new Set([...ta, ...tb]).size;
  const score = shared.length / union;

  return {
    score: Math.round(score * 1000) / 1000,
    reason:
      shared.length === 0
        ? 'No distinguishing words in common.'
        : `Shares ${shared.length} distinguishing word(s): ${shared.join(', ')}.`,
  };
}

/**
 * Score every unlinked candidate pair and return the plausible ones, strongest
 * first. Already-linked pairs are dropped — a suggestion to do what has already
 * been done is noise in a review queue.
 */
export function suggestLinks(candidates: LinkCandidateRow[]): PurposeLinkSuggestion[] {
  return candidates
    .filter((c) => !c.already_linked)
    .map((c) => {
      const { score, reason } = scoreCandidate(c.consent_purpose_name, c.inventory_purpose_name);
      return {
        consentPurposeId: c.consent_purpose_id,
        consentPurposeName: c.consent_purpose_name,
        inventoryPurposeId: c.inventory_purpose_id,
        inventoryPurposeName: c.inventory_purpose_name,
        entryCategory: c.entry_category,
        confidence: score,
        reason,
      };
    })
    .filter((s) => s.confidence >= SUGGESTION_FLOOR)
    .sort((x, y) => y.confidence - x.confidence);
}
