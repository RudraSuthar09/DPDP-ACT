-- FR-GRV-02 — Grievance/complaint intake and categorisation, on top of the
-- shared request substrate (1737001800000_request-substrate.sql).
--
-- This is the first real occupant of the pattern that migration's own header
-- describes as the intended shape for a specialising module: a table keyed by
-- `request_tickets.id`, owned entirely by Grievance, never joined against by
-- request/* and never referenced by request/*'s own code (R2). The word
-- "grievance" does not appear anywhere in the substrate migration; this file
-- is where it is allowed to.
--
-- Mutable, not append-only. A category is a triage tag, not a fact requiring
-- its own trail — the same precedent as `inventory_register_entries`'
-- `pii_decision` (a current classification staff may correct), not the same
-- precedent as `request_correspondence` (words once said, never revised).
-- `set_by` is NULL when the row was written by the anonymous portal intake
-- itself (there is no user to attribute it to — same reasoning as
-- `request_tickets` carrying no actor for a public submission) and is set
-- to the acting staff member's id on a later recategorisation.

-- Up Migration

CREATE TABLE grievance_details (
  ticket_id   uuid PRIMARY KEY REFERENCES request_tickets (id),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant()
                REFERENCES organisations (id),

  category    text NOT NULL CHECK (category IN (
                'consent_violation', 'unauthorized_sharing', 'data_not_corrected',
                'data_not_erased', 'excessive_collection',
                'no_response_to_rights_request', 'marketing_after_opt_out',
                'security_or_breach_concern', 'other'
              )),

  set_by      uuid REFERENCES users (id),
  set_at      timestamptz NOT NULL DEFAULT now(),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE grievance_details IS
  'FR-GRV-02 — grievance-specific fields on top of the shared request '
  'substrate. Exactly one row per grievance ticket, keyed by ticket_id. '
  'Never read or written by backend/src/modules/request/* (R2) — only by '
  'GrievanceModule, through RequestService for everything about the ticket '
  'itself.';

SELECT app.apply_tenant_rls('public.grievance_details');

CREATE INDEX grievance_details_category_idx ON grievance_details (tenant_id, category);

-- Down Migration

DROP TABLE IF EXISTS grievance_details;
