/**
 * A slug that doesn't resolve to a tenant (`page.tsx` calls Next's
 * `notFound()`) lands here — a real 404 response, styled like the rest of the
 * portal rather than the framework's default page, since a mistyped or
 * expired link is the ordinary way a visitor gets here, not a bug.
 */
export default function PortalNotFound() {
  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <h1>We couldn&apos;t find that page</h1>
        <p className="muted">
          This link doesn&apos;t match an organisation on this platform. Check the link the
          organisation gave you, or contact them directly to confirm the correct address.
        </p>
      </div>
    </div>
  );
}
