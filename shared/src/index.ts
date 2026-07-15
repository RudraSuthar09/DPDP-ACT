/**
 * @dpdp/shared — types and constants shared across the API, worker, and web.
 *
 * Types only. No business logic lives here (see CLAUDE.md). These are the stable
 * contracts that let modules communicate through interfaces (R2) rather than
 * reaching into each other's tables.
 */
export * from './domain';
export * from './seams';
export * from './consent';
