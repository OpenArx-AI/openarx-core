// ── methodist-v2 door surface (F2.3) — mount-ready entry ─────────────────────
//
// The wave-v2 methodist doors driven by the real interpreter/door-engine over
// live backends (Neo4j/Postgres/Vertex). Mounted by gateway-v4 (F2.7) in Phase 3 with
// the role model (mcp_profiles_v4: researcher/governance, no scopes); deliberately
// NOT wired into the live v3 profiles here so the live surface stays untouched.

export { registerMethodistDoors } from './doors.js';
export { buildDoorEngine } from './engine.js';
export {
  registerScientificReads,
  projectScientific,
  getScientific,
  searchScientific,
  findScientific,
  SCIENTIFIC_LABELS,
  PROCESS_LABELS,
} from './scientific-reads.js';
