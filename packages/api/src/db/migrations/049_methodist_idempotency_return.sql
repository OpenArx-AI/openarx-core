-- 049_methodist_idempotency_return.sql
-- 2g / openarx-bass (§5.4 inv.2 determinism; §layer_2 audit #4).
--
-- Idempotency was recorded only on GO (`ref` = the published bundle/activity id). A hand-in
-- RETURNed by the methodist left NO key, so re-submitting the SAME content re-ran the model
-- → possibly a different verdict → "roll the submission until a random GO" (persistence >
-- quality — an anti-gaming hole in the same class as forged-stage).
--
-- Fix: store the FULL outcome (GO ref OR RETURN reasons/corrections) keyed by
-- (run_id, stage, submission_hash), so `check-idempotency` can short-circuit BOTH GO and
-- RETURN BEFORE call-model. The key format is app-side (the text PK is unchanged); this
-- migration only widens the row to carry a RETURN outcome:
--   • outcome jsonb — the replayable outcome ({verdict, ref?, reasons?, corrections?}).
--   • ref → nullable (a RETURN has no published ref).
-- An identical re-run (same hash on same run/stage) is blocked; DIFFERENT work (new hash)
-- still reaches the model → new judgment (the refinement cycle stays alive).

ALTER TABLE methodist_idempotency ADD COLUMN IF NOT EXISTS outcome jsonb;
ALTER TABLE methodist_idempotency ALTER COLUMN ref DROP NOT NULL;
