/**
 * A slug that doesn't resolve to a published consent form lands here — same
 * pattern as the request portal's not-found.tsx. A mistyped or unpublished
 * link is the ordinary way a visitor gets here, not a bug.
 */
export default function FormNotFound() {
  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <h1>We couldn&apos;t find that form</h1>
        <p className="muted">
          This link doesn&apos;t match a published consent form on this platform. Check the link
          you were given, or contact the organisation directly.
        </p>
      </div>
    </div>
  );
}
