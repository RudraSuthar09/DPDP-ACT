/**
 * Phase 3G-1 — a SUGGESTION only. Pure name-similarity between a form field's
 * label and the client's existing column names; this NEVER selects, applies, or
 * saves anything by itself. It is purely a hint the builder may display next to
 * the "existing column" picker — the client still has to click to accept it.
 *
 * No AI, no business-meaning inference (it does not know what "Aadhaar" means —
 * it only compares strings). If nothing looks close, it returns null and the
 * builder just shows the full column list with no suggestion.
 */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Very small token-overlap heuristic: normalize both strings, and consider it
 *  a candidate match if one contains the other (after stripping punctuation/
 *  spacing), or they are identical once normalized. */
export function suggestColumnMatch(fieldLabel: string, availableColumns: readonly string[]): string | null {
  const label = normalize(fieldLabel);
  if (!label) return null;

  let best: string | null = null;
  for (const column of availableColumns) {
    const col = normalize(column);
    if (!col) continue;
    if (col === label || col.includes(label) || label.includes(col)) {
      // Prefer the closest length match among candidates.
      if (!best || Math.abs(col.length - label.length) < Math.abs(normalize(best).length - label.length)) {
        best = column;
      }
    }
  }
  return best;
}
