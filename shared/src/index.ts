/**
 * @dpdp/shared — types and constants shared across the API, worker, and web.
 *
 * Types only. No business logic lives here (see CLAUDE.md). These are the stable
 * contracts that let modules communicate through interfaces (R2) rather than
 * reaching into each other's tables.
 */
export * from './domain';
export * from './seams';
export * from './datasource';
export * from './gateway';
export * from './consent';
export * from './consent-notices';
export * from './dashboard';
export * from './request';
export * from './grievance';
export * from './dprequest';
export * from './dpr-summary';
export * from './breach';
