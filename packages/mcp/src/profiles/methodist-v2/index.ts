// ── methodist-v2 door surface (F2.3) — LIVE ──────────────────────────────────
//
// The wave-v2 methodist doors driven by the real interpreter/door-engine over
// live backends (Neo4j/Postgres/Vertex). LIVE on the v4 researcher role (F2.7,
// mcp_profiles_v4: researcher/governance, no scopes): registerMethodistDoors is wired
// into RESEARCHER by role, no scope gate. The v3 profiles are superseded compatibility
// facades only. [Was "mount-ready / Phase-3-pending" pre-cutover — updated to reflect live.]

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
