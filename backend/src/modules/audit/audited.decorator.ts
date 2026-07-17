import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'dpdp:audited';
export const NO_AUDIT_KEY = 'dpdp:no-audit';

/**
 * Give a route a stable, semantic audit action name.
 *
 *   @Audited('identity.user.suspended')
 *
 * Auditing does NOT depend on this decorator — every mutating request is audited
 * whether or not anyone remembered to annotate it (see AuditInterceptor). What
 * this adds is the name. That matters more than it looks: these strings outlive
 * the code that writes them. `identity.user.suspended` is what someone greps for
 * in three years; `UsersController.setStatus` is what they get if nobody chose,
 * and it stops being true the moment the method is renamed.
 */
export const Audited = (action: string) => SetMetadata(AUDITED_KEY, action);

/**
 * Exempt a route from auditing.
 *
 * Should be almost empty forever. The bar is "this request changes nothing and
 * records nothing" — a health check, a readiness probe. It is NOT for noisy
 * endpoints: volume is a retention problem, not a reason to stop keeping
 * evidence. Every use is a place someone decided an action did not need to be
 * accounted for, which is exactly the decision an auditor will want to find, so
 * it is a named decorator and greppable rather than a config list.
 */
export const NoAudit = () => SetMetadata(NO_AUDIT_KEY, true);
