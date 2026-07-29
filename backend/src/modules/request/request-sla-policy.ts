import { BadRequestException } from '@nestjs/common';
import {
  ESCALATION_RUNGS,
  type EscalationLadderStep,
  type EscalationRung,
  type EscalationTrigger,
  type RequestType,
} from '@dpdp/shared';

/**
 * SLA policy as DATA — the FR-BRC-02 rule ("deadlines are data, not code; no
 * statutory timeline is ever hardcoded") applied to the request substrate.
 *
 * A tenant's real policy is a row in `request_sla_policies`. What is in this
 * file is the PLATFORM DEFAULT used when a tenant has not set one, and the
 * arithmetic that turns a policy into deadlines. Two things about that are
 * deliberate:
 *
 *   * The default is a named, exported value in ONE place, not a literal in a
 *     service. When counsel revises what "reasonable" means, there is exactly
 *     one line to change and exactly one place to look for what was in force.
 *   * The ladder is expressed in PERCENTAGES of the SLA, not in hours. The same
 *     ladder definition then works unchanged for a 30-day rights request and a
 *     72-hour complaint, which is what lets one substrate serve both modules
 *     without either one's timings leaking into the other's.
 *
 * NOTE ON THE NUMBERS. 30 days for both is a placeholder that is honest about
 * being one: the DPDP Rules set the operative periods and they are not final at
 * the time of writing. It is a default, it is overridable per tenant, and it is
 * recorded on each ticket as a snapshot — so no ticket is ever silently
 * re-judged against a timeline that did not exist when it was filed.
 */

export interface SlaPolicyValue {
  slaSeconds: number;
  ladder: EscalationLadderStep[];
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * The standard three-rung ladder: warn the Grievance Officer at the halfway
 * mark, pull in the DPO at 80%, and hand to the escalation contact at the
 * deadline itself. Two proximity alerts and one breach — enough that nobody can
 * say they were not told, few enough that the alerts still mean something.
 */
const STANDARD_LADDER: EscalationLadderStep[] = [
  { level: 1, atPercent: 50, rung: 'grievance_officer' },
  { level: 2, atPercent: 80, rung: 'dpo' },
  { level: 3, atPercent: 100, rung: 'escalation_contact' },
];

export const DEFAULT_SLA_POLICIES: Readonly<Record<RequestType, SlaPolicyValue>> = {
  grievance: { slaSeconds: THIRTY_DAYS_SECONDS, ladder: STANDARD_LADDER },
  dprequest: { slaSeconds: THIRTY_DAYS_SECONDS, ladder: STANDARD_LADDER },
};

export function defaultPolicyFor(requestType: RequestType): SlaPolicyValue {
  const policy = DEFAULT_SLA_POLICIES[requestType];
  return { slaSeconds: policy.slaSeconds, ladder: policy.ladder.map((s) => ({ ...s })) };
}

/**
 * Validate a ladder supplied over the API. Done here rather than as a jsonb
 * CHECK constraint because a constraint expressive enough to say all of this
 * would be a second copy of the rule, in a different language, free to diverge.
 */
export function parseLadder(value: unknown): EscalationLadderStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('ladder must be a non-empty array of escalation steps.');
  }
  if (value.length > 10) {
    throw new BadRequestException('ladder may have at most 10 steps.');
  }

  const steps = value.map((raw, index) => {
    const step = raw as Record<string, unknown>;
    const level = Number(step.level);
    const atPercent = Number(step.atPercent);
    const rung = step.rung;

    if (!Number.isInteger(level) || level < 1) {
      throw new BadRequestException(`ladder[${index}].level must be a positive integer.`);
    }
    if (!Number.isFinite(atPercent) || atPercent <= 0 || atPercent > 100) {
      throw new BadRequestException(
        `ladder[${index}].atPercent must be greater than 0 and at most 100. ` +
          'A rung past the deadline is not expressible: an SLA that can be breached ' +
          'without anyone being told is not an SLA.',
      );
    }
    if (typeof rung !== 'string' || !(ESCALATION_RUNGS as readonly string[]).includes(rung)) {
      throw new BadRequestException(
        `ladder[${index}].rung must be one of: ${ESCALATION_RUNGS.join(', ')}`,
      );
    }
    return { level, atPercent, rung: rung as EscalationRung };
  });

  const sorted = [...steps].sort((a, b) => a.level - b.level);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]!.level !== i + 1) {
      throw new BadRequestException('ladder levels must be 1..n with no gaps or duplicates.');
    }
    if (i > 0 && sorted[i]!.atPercent <= sorted[i - 1]!.atPercent) {
      throw new BadRequestException('ladder steps must escalate: atPercent must strictly increase.');
    }
  }
  return sorted;
}

/** One deadline the substrate will ask the WorkflowRunner to schedule. */
export interface PlannedTimer {
  level: number;
  rung: EscalationRung;
  trigger: Exclude<EscalationTrigger, 'manual'>;
  dueAt: Date;
}

/**
 * Turn a policy plus a start instant into the concrete ladder of deadlines.
 *
 * This is the ONLY arithmetic on deadlines anywhere in the substrate. Nothing
 * downstream computes an interval, compares a timestamp to `now`, or decides
 * whether something is late — the WorkflowRunner (S3) owns "has this moment
 * arrived", and this function owns "which moments did we ask about". That split
 * is what keeps `if (daysSince > 3)` from reappearing in a controller.
 */
export function planTimers(policy: SlaPolicyValue, startedAt: Date): PlannedTimer[] {
  return policy.ladder.map((step) => ({
    level: step.level,
    rung: step.rung,
    // 100% IS the deadline, so it is the breach; anything before it is a warning
    // that the deadline is approaching.
    trigger: step.atPercent >= 100 ? 'sla_breach' : 'sla_proximity',
    dueAt: new Date(startedAt.getTime() + policy.slaSeconds * 1000 * (step.atPercent / 100)),
  }));
}

/** When the SLA itself expires (100%), independent of where the ladder's rungs sit. */
export function slaDueAt(policy: SlaPolicyValue, startedAt: Date): Date {
  return new Date(startedAt.getTime() + policy.slaSeconds * 1000);
}
