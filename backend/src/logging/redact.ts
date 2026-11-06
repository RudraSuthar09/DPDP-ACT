/**
 * Log-safe forms of personal identifiers.
 *
 * Application logs end up somewhere broader than the database — a log
 * aggregator, a support ticket, a screen share — and outlive it. An e-mail
 * address or phone number in a log line is personal data held outside every
 * control the platform applies to its own tables. These keep just enough to
 * correlate repeated events (a brute-force run against one account still
 * reads as one account) without recording who it was.
 */

/** "asha.rao@example.com" -> "a***@example.com"; "+919876543210" -> "***3210". */
export function maskRecipient(value: string): string {
  const v = value.trim();
  const at = v.lastIndexOf('@');
  if (at > 0) return `${v[0]}***${v.slice(at)}`;
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 4) return `***${digits.slice(-4)}`;
  return '***';
}
