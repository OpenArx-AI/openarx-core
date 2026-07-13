-- 045_methodist_journal.sql
-- A5 methodist activity placement — PM ruling (mcp_profiles_v3.md §13.3 finalized):
-- "process private, outcomes public; the admission band + ranking read ONLY outcomes."
--
-- PROCESS exchanges (hand-ins, doses, corrections, diagnoses, escalations, course
-- steps) → this INTERNAL journal, NOT the public Layer 2 graph. A public per-attester
-- stream of exchanges would proxy the correction-density / remediation signal the
-- dossier keeps private (and re-open the "secret button" the transparency invariant
-- forbids). Invariant-4 audit is fully preserved by this internal journal.
--
-- OUTCOMES (four classes: co-sign, contested-attestation, autonomy-tier-change,
-- course-completion) → public Layer 2 activities (handled in code — the admission
-- band reads only these). A3 fields (applied_instrument/genre) work in BOTH places.

CREATE TABLE IF NOT EXISTS methodist_journal (
  id                 bigserial PRIMARY KEY,
  credential_id      text NOT NULL,
  tool               text NOT NULL,        -- methodist_diagnose | checkpoint | escalate | course
  applied_instrument text,                 -- A3 (the tool / instrument that drove the exchange)
  genre              text,                  -- A3 (methodological genre)
  detail             jsonb,                 -- internal-only exchange summary (never leaves the journal)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_methodist_journal_cred ON methodist_journal (credential_id, created_at);
