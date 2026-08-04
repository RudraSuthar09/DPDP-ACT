-- FR-INV-11: (a) let a sector template seed SYSTEMS and VENDORS, not just data
-- elements, and (b) add the CA / tax-practice template.
--
-- WHY THE SHAPE CHANGES. The template mechanism could seed elements and their
-- purposes but had no way to express "and these are the four places those
-- documents live, and these are the three parties they get sent to" — so a
-- freshly-seeded tenant's RoPA showed every element with "Systems: None
-- recorded / Vendors: None recorded", which is exactly the part of the record a
-- regulator reads first. Systems and vendors are already first-class, generic
-- entities (FR-INV-06/07); this migration only lets a template pre-fill them,
-- through the same repositories the manual forms use. No new concept.
--
-- Stored as TWO NEW COLUMNS rather than by reshaping `elements` into an object:
-- `elements` stays a jsonb array so the four existing template versions remain
-- valid and unread-modified (I4 — a version row is never UPDATEd). An element
-- may now additionally carry `systemRefs` / `vendorRefs`, which name entries in
-- these arrays BY NAME; sector-templates.service.ts resolves those names to the
-- ids it just created and links them. Both new columns default to '[]', so the
-- existing templates keep their exact current behaviour.
--
-- WHY THE CA TEMPLATE LOOKS LIKE THIS. It is a transcription of the firm's own
-- KYC SOP (steps 1-11): the SOP's engagements become purposes, its authorised
-- channels and storage become systems, its "authorised government authorities,
-- banks or technology providers" become vendors. The SOP says "such as" —
-- so does this template. Every retention value below carries its own INDICATIVE
-- caveat IN THE STORED STRING, not merely in a UI banner: the string is what
-- travels into the RoPA PDF/XLSX and into a DPR Personal Data Summary, and a
-- caveat that only exists on the screen where it was seeded is not a caveat at
-- all. Nothing here is legal advice and nothing here is locked — an applied
-- template is ordinary tenant data, editable and re-versionable like any row a
-- human typed.

-- Up Migration

ALTER TABLE inventory_sector_template_versions
  ADD COLUMN systems jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN vendors jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN inventory_sector_template_versions.systems IS
  'Array of { name, systemType, description, hostingLocation, accessControlNote } '
  'seeded into inventory_systems on apply. Referenced from an element''s '
  '"systemRefs" by name. Shape validated in sector-templates.service.ts.';

COMMENT ON COLUMN inventory_sector_template_versions.vendors IS
  'Array of { name, description, contactEmail, dpaReference, country } seeded '
  'into inventory_vendors on apply. Referenced from an element''s "vendorRefs" '
  'as { name, transferNotes }. Shape validated in sector-templates.service.ts.';

-- Widen the sector catalog. Postgres named the inline column CHECK
-- <table>_<column>_check when 1737001200000 created it.
ALTER TABLE inventory_sector_templates
  DROP CONSTRAINT IF EXISTS inventory_sector_templates_sector_check;

ALTER TABLE inventory_sector_templates
  ADD CONSTRAINT inventory_sector_templates_sector_check
  CHECK (sector IN ('healthcare', 'retail', 'edtech', 'fintech', 'ca_tax_practice'));

INSERT INTO inventory_sector_templates (sector, name) VALUES
  ('ca_tax_practice', 'CA / tax practice — KYC starting point');

INSERT INTO inventory_sector_template_versions (template_id, version_number, elements, systems, vendors)
SELECT
  id,
  1,
  $elements$[
  {
    "category": "Aadhaar Card",
    "description": "Aadhaar card copy collected as KYC identity proof. Record the document as a category here — never the Aadhaar number itself. Starting point from the firm's KYC SOP (step 1): edit, add to, or remove anything that does not match how this practice actually works.",
    "storageLocation": "Firm's document server — client folder, prescribed file-naming convention",
    "systemRefs": ["Official Office WhatsApp", "Official Office Email", "Secure Client Portal", "Firm's Document Server / Storage"],
    "vendorRefs": [
      { "name": "Income Tax Portal", "transferNotes": "Quoted or uploaded where the portal requires Aadhaar-based identity verification for the assignment." },
      { "name": "GST Portal", "transferNotes": "Uploaded as identity proof with a GST registration application." }
    ],
    "purposes": [
      { "purposeName": "Income Tax Return (ITR) filing", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement to file the client's return under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant assessment year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PAN registration on the Income Tax Portal", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement to obtain/register PAN on the client's behalf.",
        "retentionPeriod": "3 years after the registration is completed. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "GST Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for registration under the CGST/SGST Acts, 2017.",
        "retentionPeriod": "6 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTRC Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for Profession Tax Registration Certificate under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTEC Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for Profession Tax Enrolment Certificate under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "TAN / TDS Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for TAN allotment and TDS compliance under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." }
    ]
  },
  {
    "category": "PAN Card",
    "description": "PAN card copy collected as KYC identity/tax proof. Starting point from the firm's KYC SOP (step 1) — edit freely.",
    "storageLocation": "Firm's document server — client folder, prescribed file-naming convention",
    "systemRefs": ["Official Office WhatsApp", "Official Office Email", "Secure Client Portal", "Firm's Document Server / Storage"],
    "vendorRefs": [
      { "name": "Income Tax Portal", "transferNotes": "Quoted on every return, registration and TDS filing made for the client." },
      { "name": "GST Portal", "transferNotes": "Filed with the GST registration application and quoted on subsequent filings." },
      { "name": "Client's Bank", "transferNotes": "Shared only where the bank requires it to complete the authorised assignment." }
    ],
    "purposes": [
      { "purposeName": "Income Tax Return (ITR) filing", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement to file the client's return under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant assessment year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PAN registration on the Income Tax Portal", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement to obtain/register PAN on the client's behalf.",
        "retentionPeriod": "3 years after the registration is completed. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "GST Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for registration under the CGST/SGST Acts, 2017.",
        "retentionPeriod": "6 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTRC Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for Profession Tax Registration Certificate under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTEC Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for Profession Tax Enrolment Certificate under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "TAN / TDS Registration", "legalBasis": "contract",
        "legalBasisNote": "Professional engagement for TAN allotment and TDS compliance under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." }
    ]
  },
  {
    "category": "Bank Account Details (account number + IFSC)",
    "description": "Client's bank account number and IFSC code, verified before use (SOP step 7). Starting point — edit freely.",
    "storageLocation": "Firm's document server — client folder, prescribed file-naming convention",
    "systemRefs": ["Official Office WhatsApp", "Official Office Email", "Secure Client Portal", "Firm's Document Server / Storage"],
    "vendorRefs": [
      { "name": "Income Tax Portal", "transferNotes": "Pre-validated on the portal so any refund can be credited to the client." },
      { "name": "GST Portal", "transferNotes": "Bank proof filed with the GST registration application." },
      { "name": "Client's Bank", "transferNotes": "Confirmed with the bank where particulars need verification before filing." }
    ],
    "purposes": [
      { "purposeName": "Income Tax Return (ITR) filing", "legalBasis": "contract",
        "legalBasisNote": "Bank pre-validation for refund credit as part of the filing engagement.",
        "retentionPeriod": "8 years from the end of the relevant assessment year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "GST Registration", "legalBasis": "contract",
        "legalBasisNote": "Bank proof is a prescribed document for registration under the CGST/SGST Acts, 2017.",
        "retentionPeriod": "6 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTRC Registration", "legalBasis": "contract",
        "legalBasisNote": "Bank particulars required with the PTRC application under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PTEC Registration", "legalBasis": "contract",
        "legalBasisNote": "Bank particulars required with the PTEC application under the applicable State profession tax Act.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "TAN / TDS Registration", "legalBasis": "contract",
        "legalBasisNote": "Bank particulars used for TDS challan payment under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant financial year. INDICATIVE starting point — confirm the exact statutory period before relying on this." }
    ]
  },
  {
    "category": "Date of Birth",
    "description": "Client's date of birth, verified against the KYC documents before filing (SOP step 7). Starting point — edit freely.",
    "storageLocation": "Firm's document server — client folder, prescribed file-naming convention",
    "systemRefs": ["Official Office WhatsApp", "Official Office Email", "Secure Client Portal", "Firm's Document Server / Storage"],
    "vendorRefs": [
      { "name": "Income Tax Portal", "transferNotes": "Entered on the portal where it forms part of identity verification for the assignment." }
    ],
    "purposes": [
      { "purposeName": "Income Tax Return (ITR) filing", "legalBasis": "contract",
        "legalBasisNote": "Identity particular verified before filing under the Income-tax Act, 1961.",
        "retentionPeriod": "8 years from the end of the relevant assessment year. INDICATIVE starting point — confirm the exact statutory period before relying on this." },
      { "purposeName": "PAN registration on the Income Tax Portal", "legalBasis": "contract",
        "legalBasisNote": "Prescribed particular on the PAN application.",
        "retentionPeriod": "3 years after the registration is completed. INDICATIVE starting point — confirm the exact statutory period before relying on this." }
    ]
  }
]$elements$::jsonb,
  $systems$[
  {
    "name": "Official Office WhatsApp",
    "systemType": "Messaging channel",
    "description": "Authorised channel for clients to submit KYC documents (SOP step 2). Documents received here are downloaded to the firm's document server; nothing is left to accumulate on the handset.",
    "hostingLocation": "WhatsApp (Meta) — firm's official handset",
    "accessControlNote": "Official number is operated only by the partner and the staff member assigned to the engagement. Handset is PIN/biometric locked. Starting point — replace with this firm's actual policy."
  },
  {
    "name": "Official Office Email",
    "systemType": "Email",
    "description": "Authorised channel for clients to submit KYC documents (SOP step 2).",
    "hostingLocation": "Firm's email provider",
    "accessControlNote": "Mailbox access limited to the partner and the staff assigned to the engagement; credentials are not shared. Starting point — replace with this firm's actual policy."
  },
  {
    "name": "Secure Client Portal",
    "systemType": "Client portal",
    "description": "Preferred submission channel where available (SOP step 2) — clients upload documents directly instead of sending them over a messaging channel.",
    "hostingLocation": "Portal provider",
    "accessControlNote": "Per-client login; firm-side access restricted to staff assigned to that client's engagement. Starting point — replace with this firm's actual policy."
  },
  {
    "name": "Firm's Document Server / Storage",
    "systemType": "File store",
    "description": "The firm's authorised computer/server where downloaded documents are filed in the client's folder under the prescribed naming convention (SOP step 4).",
    "hostingLocation": "On-premise — firm's office",
    "accessControlNote": "Access restricted to employees directly involved in the relevant assignment, strictly on a need-to-know basis; access to client folders is logged wherever feasible; role-based access control, password protection and encryption applied where feasible (SOP steps 4, 5 and 10). Starting point — replace with this firm's actual policy."
  }
]$systems$::jsonb,
  $vendors$[
  {
    "name": "Income Tax Portal",
    "description": "Government e-filing portal used to file returns and complete PAN / TAN registrations for the client (SOP step 8).",
    "contactEmail": null,
    "dpaReference": null,
    "country": "India"
  },
  {
    "name": "GST Portal",
    "description": "Government GST portal used for GST registration and subsequent compliance filings for the client (SOP step 8).",
    "contactEmail": null,
    "dpaReference": null,
    "country": "India"
  },
  {
    "name": "Client's Bank",
    "description": "The client's own bank, where account particulars must be confirmed or produced to carry out the authorised assignment (SOP steps 7 and 8).",
    "contactEmail": null,
    "dpaReference": null,
    "country": "India"
  }
]$vendors$::jsonb
FROM inventory_sector_templates WHERE sector = 'ca_tax_practice';

-- Down Migration

DELETE FROM inventory_sector_template_versions
  WHERE template_id IN (SELECT id FROM inventory_sector_templates WHERE sector = 'ca_tax_practice');
DELETE FROM inventory_sector_templates WHERE sector = 'ca_tax_practice';

ALTER TABLE inventory_sector_templates
  DROP CONSTRAINT IF EXISTS inventory_sector_templates_sector_check;
ALTER TABLE inventory_sector_templates
  ADD CONSTRAINT inventory_sector_templates_sector_check
  CHECK (sector IN ('healthcare', 'retail', 'edtech', 'fintech'));

ALTER TABLE inventory_sector_template_versions
  DROP COLUMN IF EXISTS vendors,
  DROP COLUMN IF EXISTS systems;
