# Methodist methodology SOURCE (methodist-owned content)

Single source-of-truth for the LIVE methodology the interpreter consumes. Replaces the
old "openarx-methodist repo = source, Core mirrors a fixture" contract (removes split-brain).
Established for the co-developer wave (contracts 0074, promo 0051/0052).

## Ownership (the confirmed seam — contracts 0074)
- **Methodist owns the VALUES here** — methodology content + `record_schemas` values.
  Authors via `methodist/*` branches + MR (use a `git worktree`, never switch the shared
  `main` checkout).
- **Core owns** the FORMAT/envelope (record_schemas structure), the generator, the
  interpreter, and merge + deploy.

## Files (methodist authors)

### `methodology.snapshot.json`  — the interpreter `Methodology`
> Note: the baseline MAY carry inert `prompts`/`schemas` stubs. They are OVERWRITTEN at load
> by `door_prompts.snapshot.json` (engine spread), so they have NO runtime effect — keep them
> consistent with door_prompts or leave them; the authoritative prompts/schemas live in
> `door_prompts.snapshot.json`. Stripping the inert stubs is an optional future generator
> cleanup, NOT required.
```jsonc
{
  "methodology_version": "v2.0-draft1",          // single overall version string
  "_meta": { /* owner, primitives, confirmed_semantics, gated_disabled, ... */ },
  "procedures": [                                  // the 6 endpoint procedures
    {
      "name": "diagnose",
      "trigger": { "kind": "endpoint", "ref": "diagnose" },
      "steps": [
        { "id": "dossier", "primitive": "fetch-dossier", "version": "v1",
          "in": { "credential_id": "$input.agent_id" }, "out": "dossier" },
        { "id": "diag", "primitive": "call-model", "version": "v1",
          "params": { "output_schema": "diagnose_out" }, "in": { "context": "$ctx" }, "out": "diag" },
        // gate step example: { ..., "gate": { "when": "$idem.hit", "outcome": "idempotent" } }
      ],
      "outcome_from": "diag",
      "route": { "default": { "run_id": "$run.run_id", "dose": "$diag.dose", "rationale": "$diag.rationale" } }
    }
    // + checkpoint, course, consult, get_current_dose, report_need
  ],
  "_non_model_channels": { /* note: get_my_development, escalate — direct door handlers, no procedure */ }
}
```
Step schema (interpreter `Step`): `{ id, primitive, version, in?, out?, params?, gate? }` — there is
NO `kind` field; a step's kind is implicit in its `primitive` id (`call-model` = LLM, all others
deterministic). Source refs in `in`/`route`: `"$slot.path"` / `"$input.x"` / `{ "const": v }` /
arrays / nested objects. `params.prompt`/`params.output_schema` de-ref `door_prompts.*` by key;
`params.hash_scope`/`schema_ref` de-ref the Core frame specs by key.

### `door_prompts.snapshot.json`  — executable prompt bodies + Vertex output-schemas
```jsonc
{
  "prompts": {                                     // static prefix + "--- RUNTIME INPUTS ---" + {{token}} tail
    "diagnose": "…{{intent}} {{focus}} {{dossier_map}}",
    "checkpoint": "…{{submission}} {{dose}} {{dossier_map}} {{crosscheck}}",
    "course": "…", "consult": "…", "verify": "…{{records}}"
  },
  "schemas": {                                     // Vertex OBJECT schemas (required/properties)
    "diagnose_out": { "type": "object", "required": ["cycle","dose","rationale"], "properties": { … } },
    "checkpoint_verdict": { … }, "course_out": { … }, "consult_out": { … }, "verify_out": { … }
  },
  "_meta": { /* last-refresh provenance */ }
}
```
At load these OVERWRITE the (inert) `prompts`/`schemas` on the methodology object (engine spread).
The markdown door-prompt bodies are serialized into the `prompts` string values here.

### `record_schemas.json`  — per-record-type adapter schema VALUES (F0.2 / §12.7)
The registry the graph/vector/read adapters (2b) consume. Core owns the FORMAT (this envelope);
the methodist fills the VALUES per record type. It is loaded into `FrameSpecs.recordSchemas` and
referenced from an adapter step via `params.record_schema: "<type>"`. Envelope per record type:
```jsonc
{
  "claim": {
    "version": "v1",                          // → payload_schema_version; a bump = a reindex event
    "node":   { "indexed_properties": ["attester_id","run_id","claim_status"] },  // → Neo4j indexed props
    "vector": {
      "projection": "[Context] {{run}} {{edges}}\n[Claim] {{text}} {{caveats}}",  // embed-text {{field}} DSL
      "payload": ["modality","claim_type","claim_status","verification_outcome","attester_id","run_id","is_superseded","attested_at"],
      "payload_indexed": { "keyword": ["claim_type","claim_status","attester_id","run_id"], "bool": ["is_superseded"] },
      "models": ["gemini","specter2"]
    },
    "read":   { "strip_fields": ["track_note"], "pointer_when": { "field": "excerpt", "unless": "distributable" } }
  }
  // + relation / activity / metric / bundle …
}
```
Field-set keys (`indexed_properties`, `payload`, `strip_fields`) use the hash-scope-style allow-list
vocabulary; `projection` uses the `{{field}}` template DSL (like `door_prompts`). **NOTE (§12.7):**
identity hash-scopes are NOT here — they stay in the Core frame (`hashScopes`, Contracts / §4.3).
The exact per-field invariants (I1/I2/I3) + the 3 externalize points finalize with the contracts
§12.7 detail; author VALUES only on the Wave-2 `record_schemas` signal.

## Generated — do NOT hand-edit
- `../content.ts` — produced by the Core-owned generator from the files above (`methodology` +
  `doorPrompts` `as const` exports). An MR includes BOTH the changed source and the regenerated
  `content.ts` (reviewable diff). The generator lands with F0.1 (this wave).

## Flow
methodist edits source on a `methodist/<topic>` worktree branch → regenerate `content.ts` →
open MR → Core reviews (format-conformance) → tester-gate (if a code path is touched) →
Core merges to `main` + deploys. Never push to `main`; content authorship is carried in the
commit message (Co-Authored-By), not the git identity.
