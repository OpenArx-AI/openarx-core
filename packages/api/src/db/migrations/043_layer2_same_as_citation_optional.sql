-- 043_layer2_same_as_citation_optional.sql
-- A1/P1 ratification (final wave 2026-07-05, pillar §7.6): citation_context is
-- CONDITIONAL for same_as. It stays required for the six directed relations and
-- for a CITATION-based same_as (edge_provenance.source ∈ {explicit_citation,
-- agent_annotation}), but is OPTIONAL for an INFERENCE-based same_as
-- (semantic_similarity / llm_inference / platform_algorithmic / cross_agent_consensus):
-- an algorithmically-inferred equivalence has no citing sentence, and synthesizing
-- one would fabricate provenance. edge_provenance stays NOT NULL — it carries HOW
-- the edge was derived. Dropping NOT NULL is a pure relaxation: every existing row
-- already has a citation_context, so none is affected.

ALTER TABLE layer2_relations ALTER COLUMN citation_context DROP NOT NULL;
