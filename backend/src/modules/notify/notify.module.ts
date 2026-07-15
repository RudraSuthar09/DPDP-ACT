import { Module } from '@nestjs/common';

/**
 * Notifications. Transactional email (deadline alerts, acknowledgements, breach
 * notices), SMS/WhatsApp for OTP and urgent escalation (India: MSG91 / Gupshup),
 * and signed outbound webhooks to clients (consent changes, fulfilment requests).
 * A shared service used by Consent, Breach, Grievance, and DPRequest (R2).
 *
 * Requirements: FR-DSH-02/03, FR-CON-07, FR-DPR-05/08.
 * Skeleton only — no providers yet.
 */
@Module({})
export class NotifyModule {}
