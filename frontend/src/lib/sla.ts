/**
 * Client-side SLA countdown, for the staff inbox.
 *
 * The backend deliberately does no time arithmetic beyond computing
 * `slaDueAt` itself — `request-sla-policy.ts`'s comment is explicit that
 * "nothing downstream computes an interval, compares a timestamp to now, or
 * decides whether something is late." There is no server-sent
 * percent-remaining or near-breach flag to read, so "near breach" here is a
 * fixed, documented client-side heuristic (overdue / within 3 days / within 7
 * days), not a reflection of the tenant's actual escalation ladder — the real
 * ladder is `detail.timers[]` on the ticket detail read, and that is what
 * actually drives escalation.
 */
export type SlaUrgency = 'overdue' | 'urgent' | 'soon' | 'ok' | 'none';

export function slaUrgency(slaDueAt: string | null, isClosed: boolean): SlaUrgency {
  if (isClosed || !slaDueAt) return 'none';
  const ms = new Date(slaDueAt).getTime() - Date.now();
  if (ms <= 0) return 'overdue';
  if (ms <= 3 * 24 * 60 * 60 * 1000) return 'urgent';
  if (ms <= 7 * 24 * 60 * 60 * 1000) return 'soon';
  return 'ok';
}

export function slaBadgeClass(urgency: SlaUrgency): string {
  switch (urgency) {
    case 'overdue':
      return 'denied';
    case 'urgent':
      return 'warning';
    case 'soon':
      return 'info';
    case 'ok':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function slaCountdownLabel(slaDueAt: string | null, isClosed: boolean): string {
  if (isClosed) return 'Closed';
  if (!slaDueAt) return 'No SLA clock';
  const ms = new Date(slaDueAt).getTime() - Date.now();
  const abs = Math.abs(ms);
  const days = Math.floor(abs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((abs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const span = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  return ms <= 0 ? `Overdue by ${span}` : `Due in ${span}`;
}
