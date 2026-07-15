import type { ModuleName } from '@dpdp/shared';

// The four-counter dashboard layout (FR-DSH-01). In Stage 1 the counters read
// zero until the modules are wired up — that is fine and honest. No data
// fetching or business logic here yet; this is the skeleton shell.
const counters: { label: string; value: number }[] = [
  { label: 'Inventory categories mapped', value: 0 },
  { label: 'Active consents', value: 0 },
  { label: 'Open breach incidents', value: 0 },
  { label: 'Open data-principal requests', value: 0 },
];

const modules: { name: ModuleName; label: string; status: string }[] = [
  { name: 'inventory', label: 'Data Inventory', status: 'Coming in your pilot' },
  { name: 'consent', label: 'Consent Register', status: 'Coming in your pilot' },
  { name: 'breach', label: 'Breach Register', status: 'Coming in your pilot' },
  { name: 'grievance', label: 'Grievance Register', status: 'Coming in your pilot' },
  { name: 'dprequest', label: 'Data Principal Request Tracker', status: 'Coming in your pilot' },
];

export default function DashboardPage() {
  return (
    <main>
      <h1>DPDP Compliance Platform</h1>
      <p className="muted">Stage 1 skeleton · business data stays with the client.</p>

      <section className="counters" style={{ marginTop: 32 }}>
        {counters.map((c) => (
          <div className="card" key={c.label}>
            <div className="value">{c.value}</div>
            <div className="label">{c.label}</div>
          </div>
        ))}
      </section>

      <h2 style={{ marginTop: 40 }}>Modules</h2>
      <ul>
        {modules.map((m) => (
          <li key={m.name}>
            <strong>{m.label}</strong> — <span className="muted">{m.status}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
