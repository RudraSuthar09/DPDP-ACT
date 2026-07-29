/**
 * Reuses the existing badge shape and the app's existing colour tokens (no new
 * CSS classes) — high confidence borrows `.badge.success`'s green, medium
 * reuses the `.notice` amber already defined in globals.css, low is a plain
 * bordered pill using the shared --border/--muted tokens. Shared by the entry
 * detail page (Prompt 9/12) and the CSV import mapping screen (Prompt 10/11).
 */
export function PiiConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  if (confidence === 'high') {
    return <span className="badge success">High confidence</span>;
  }
  if (confidence === 'medium') {
    return (
      <span
        className="badge"
        style={{ background: '#fff8e6', color: '#8a6d1a', border: '1px solid #f0d98c' }}
      >
        Medium confidence
      </span>
    );
  }
  return (
    <span className="badge muted" style={{ border: '1px solid var(--border)' }}>
      Low confidence
    </span>
  );
}
