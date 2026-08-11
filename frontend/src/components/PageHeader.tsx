/**
 * The house page-header pattern: large H1 (+ optional subtitle) on the
 * left, primary actions right-aligned on the same row. Presentational only
 * — callers keep owning their own state/handlers, this just lays them out.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
