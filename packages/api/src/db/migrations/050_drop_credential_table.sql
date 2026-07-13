-- 050_drop_credential_table.sql
-- 2f / openarx-ia3f (§12.2 credential mint-composite, ratified Vlad 2026-07-10).
--
-- The credential = the AGENT identity as a deterministic MINT-COMPOSITE of (userId, tokenId)
-- computed at the door (credentialOf), NOT a stored row. The `credential` table (migration
-- 046) + getOrCreateCredential were never wired on the door path (ia3f's un-done task) — the
-- door always derived the credential from the token owner. The composite id supersedes them:
-- one token = one agent, minted deterministically, with an INHERENT userId-guard (a different
-- userId/tokenId → a different id → a different dossier). So drop the unused table.
--
-- NOTE: the explicit dossier owner_user_id column + re-present/continuity-across-token-change
-- guard (verify dossier[cred].owner == current userId) is a FOLLOW-UP for the OAuth contour
-- (rotating tokenId) — the direct-Bearer methodist path is covered by the inherent guard.
-- Safe/reversible: the table was empty (never written). IF EXISTS keeps it idempotent.

DROP TABLE IF EXISTS credential;
