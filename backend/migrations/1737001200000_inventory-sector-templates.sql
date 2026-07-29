-- Sector templates (FR-INV-11): pre-seed common data elements (+ purposes,
-- legal basis, retention) for a sector (healthcare, retail, edtech, fintech).
--
-- DESIGN DECISION — deliberately NOT tenant-scoped, the one exception to
-- "every table has tenant_id" in this codebase: a template is platform-curated
-- reference content ("here is what a healthcare business typically collects"),
-- not a tenant's own compliance data. It carries no tenant secret and no PII —
-- it is a catalog, the same kind of fact as the ROLES/MODULE_AREAS constants
-- in @dpdp/shared, just stored as data instead of compiled into TypeScript so
-- it can be edited/versioned without a deploy ("versioned config/seed data,
-- not hardcoded logic"). Applying a template to a tenant is a normal,
-- tenant-scoped, audited write (via RegisterEntriesRepository/PurposesRepository,
-- exactly like the guided wizard or CSV import) — only the CATALOG itself is
-- global and read-only to the app (SELECT-only grant, no INSERT/UPDATE; new
-- templates/versions arrive via migration, the same mechanism that seeds them
-- here).
--
-- Same lifecycle-table/append-only-version split as every other entity in
-- this module, minus tenant_id/RLS for the reason above.

-- Up Migration

CREATE TABLE inventory_sector_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector     text NOT NULL UNIQUE
               CHECK (sector IN ('healthcare', 'retail', 'edtech', 'fintech')),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_sector_templates IS
  'FR-INV-11: platform-curated catalog of sector templates. Deliberately NOT '
  'tenant-scoped — see this migration''s header. Read-only to the app.';

GRANT SELECT ON inventory_sector_templates TO dpdp_app;

CREATE TABLE inventory_sector_template_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid NOT NULL REFERENCES inventory_sector_templates (id),
  version_number integer NOT NULL CHECK (version_number > 0),

  -- Array of { category, description, storageLocation, purposes: [ {
  -- purposeName, legalBasis, legalBasisNote, retentionPeriod } ] }. Validated
  -- shape is enforced in application code (sector-templates.service.ts) —
  -- Postgres only guarantees it is well-formed JSON.
  elements       jsonb NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_sector_template_versions_unique UNIQUE (template_id, version_number)
);

COMMENT ON TABLE inventory_sector_template_versions IS
  'Append-only content history for one sector template. A future edit to a '
  'template INSERTs a new version via migration; nothing here is ever '
  'UPDATEd or DELETEd (I4).';

GRANT SELECT ON inventory_sector_template_versions TO dpdp_app;

CREATE INDEX inventory_sector_template_versions_current_idx
  ON inventory_sector_template_versions (template_id, version_number DESC);

-- Seed content (version 1 of each sector template).

INSERT INTO inventory_sector_templates (sector, name) VALUES
  ('healthcare', 'Healthcare provider — common data elements'),
  ('retail',     'Retail / e-commerce — common data elements'),
  ('edtech',     'EdTech — common data elements'),
  ('fintech',    'Fintech / lending — common data elements');

INSERT INTO inventory_sector_template_versions (template_id, version_number, elements)
SELECT id, 1, $json$[
  {
    "category": "Patient full name",
    "description": "Name as recorded at registration",
    "storageLocation": "Hospital management system — patients table",
    "purposes": [
      { "purposeName": "Care delivery and treatment records", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "8 years after last treatment (medical records norm)" }
    ]
  },
  {
    "category": "Contact number",
    "description": "Mobile number for appointment communication",
    "storageLocation": "Hospital management system — patients table",
    "purposes": [
      { "purposeName": "Appointment reminders and care coordination", "legalBasis": "consent",
        "legalBasisNote": null, "retentionPeriod": "Until consent withdrawn, then 30 days" }
    ]
  },
  {
    "category": "ABHA ID / Aadhaar number",
    "description": "Government health/identity id, where linked",
    "storageLocation": "Hospital management system — patients table (encrypted)",
    "purposes": [
      { "purposeName": "Statutory identity verification", "legalBasis": "legal_obligation",
        "legalBasisNote": "Ayushman Bharat Digital Mission linkage", "retentionPeriod": "As required by applicable health-records regulation" }
    ]
  },
  {
    "category": "Diagnosis / medical history notes",
    "description": "Clinical notes authored by treating physicians",
    "storageLocation": "Electronic health record system",
    "purposes": [
      { "purposeName": "Care delivery and treatment records", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "8 years after last treatment (medical records norm)" },
      { "purposeName": "Medical emergency response", "legalBasis": "legitimate_use",
        "legalBasisNote": "Section 7 medical emergency ground", "retentionPeriod": "8 years after last treatment" }
    ]
  },
  {
    "category": "Insurance/payer details",
    "description": "Policy number and insurer name for claims",
    "storageLocation": "Billing system",
    "purposes": [
      { "purposeName": "Insurance claims processing", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "7 years after claim closure" }
    ]
  }
]$json$::jsonb
FROM inventory_sector_templates WHERE sector = 'healthcare';

INSERT INTO inventory_sector_template_versions (template_id, version_number, elements)
SELECT id, 1, $json$[
  {
    "category": "Customer full name",
    "description": "Name provided at account creation or checkout",
    "storageLocation": "E-commerce platform — customers table",
    "purposes": [
      { "purposeName": "Order fulfilment", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "5 years after last order (tax/audit norm)" }
    ]
  },
  {
    "category": "Email address",
    "description": "Primary contact and login identifier",
    "storageLocation": "E-commerce platform — customers table",
    "purposes": [
      { "purposeName": "Order fulfilment and support", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "5 years after last order" },
      { "purposeName": "Marketing communications", "legalBasis": "consent",
        "legalBasisNote": null, "retentionPeriod": "Until consent withdrawn" }
    ]
  },
  {
    "category": "Delivery address",
    "description": "Shipping address for order delivery",
    "storageLocation": "E-commerce platform — orders table",
    "purposes": [
      { "purposeName": "Order fulfilment", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "5 years after last order" }
    ]
  },
  {
    "category": "Payment card token",
    "description": "Tokenised card reference from the payment gateway — never the raw PAN",
    "storageLocation": "Payment gateway vault (tokenised)",
    "purposes": [
      { "purposeName": "Payment processing", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "As long as the card token remains valid, then purged" }
    ]
  },
  {
    "category": "Purchase history",
    "description": "Past orders and browsing-derived preferences",
    "storageLocation": "E-commerce platform — orders/analytics tables",
    "purposes": [
      { "purposeName": "Personalised recommendations", "legalBasis": "consent",
        "legalBasisNote": null, "retentionPeriod": "Until consent withdrawn" }
    ]
  }
]$json$::jsonb
FROM inventory_sector_templates WHERE sector = 'retail';

INSERT INTO inventory_sector_template_versions (template_id, version_number, elements)
SELECT id, 1, $json$[
  {
    "category": "Student full name",
    "description": "Name as recorded at enrolment",
    "storageLocation": "Student information system",
    "purposes": [
      { "purposeName": "Enrolment and academic administration", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "Duration of enrolment plus 3 years" }
    ]
  },
  {
    "category": "Parent/guardian contact details",
    "description": "Phone and email for a minor's parent or guardian",
    "storageLocation": "Student information system",
    "purposes": [
      { "purposeName": "Parental consent management and communication", "legalBasis": "consent",
        "legalBasisNote": "Verifiable parental consent for a minor, DPDP Act", "retentionPeriod": "Duration of enrolment plus 3 years" }
    ]
  },
  {
    "category": "Academic records",
    "description": "Grades, assessments, progress reports",
    "storageLocation": "Learning management system",
    "purposes": [
      { "purposeName": "Academic administration and reporting", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "Duration of enrolment plus 7 years" }
    ]
  },
  {
    "category": "Attendance data",
    "description": "Daily/session attendance records",
    "storageLocation": "Learning management system",
    "purposes": [
      { "purposeName": "Academic administration", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "Duration of enrolment plus 3 years" }
    ]
  },
  {
    "category": "Health/allergy information",
    "description": "Medical conditions relevant to on-campus safety, where disclosed",
    "storageLocation": "Student information system (restricted access)",
    "purposes": [
      { "purposeName": "Student safety and emergency response", "legalBasis": "legitimate_use",
        "legalBasisNote": "Section 7 medical emergency / safety ground", "retentionPeriod": "Duration of enrolment" }
    ]
  }
]$json$::jsonb
FROM inventory_sector_templates WHERE sector = 'edtech';

INSERT INTO inventory_sector_template_versions (template_id, version_number, elements)
SELECT id, 1, $json$[
  {
    "category": "PAN",
    "description": "Permanent Account Number for identity/tax verification",
    "storageLocation": "Core banking / lending platform (encrypted)",
    "purposes": [
      { "purposeName": "KYC and statutory identity verification", "legalBasis": "legal_obligation",
        "legalBasisNote": "RBI KYC master direction", "retentionPeriod": "10 years after account closure (RBI norm)" }
    ]
  },
  {
    "category": "Aadhaar number",
    "description": "Government identity number, where used for e-KYC",
    "storageLocation": "Core banking / lending platform (encrypted)",
    "purposes": [
      { "purposeName": "KYC and statutory identity verification", "legalBasis": "legal_obligation",
        "legalBasisNote": "RBI KYC master direction", "retentionPeriod": "10 years after account closure (RBI norm)" }
    ]
  },
  {
    "category": "Bank account number",
    "description": "Linked account for disbursement and repayment",
    "storageLocation": "Core banking / lending platform",
    "purposes": [
      { "purposeName": "Loan disbursement and repayment processing", "legalBasis": "contract",
        "legalBasisNote": null, "retentionPeriod": "10 years after account closure (RBI norm)" }
    ]
  },
  {
    "category": "Transaction history",
    "description": "Payment and repayment transaction records",
    "storageLocation": "Core banking / lending platform",
    "purposes": [
      { "purposeName": "Statutory financial record-keeping", "legalBasis": "legal_obligation",
        "legalBasisNote": null, "retentionPeriod": "10 years after transaction (RBI norm)" },
      { "purposeName": "Credit risk assessment", "legalBasis": "legitimate_use",
        "legalBasisNote": null, "retentionPeriod": "10 years after account closure" }
    ]
  },
  {
    "category": "KYC document reference",
    "description": "Pointer to the verified identity/address proof on file",
    "storageLocation": "Document management system (restricted access)",
    "purposes": [
      { "purposeName": "KYC and statutory identity verification", "legalBasis": "legal_obligation",
        "legalBasisNote": "RBI KYC master direction", "retentionPeriod": "10 years after account closure (RBI norm)" }
    ]
  }
]$json$::jsonb
FROM inventory_sector_templates WHERE sector = 'fintech';

-- Down Migration

DROP TABLE IF EXISTS inventory_sector_template_versions;
DROP TABLE IF EXISTS inventory_sector_templates;
