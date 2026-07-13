-- 041_layer2_events.sql
-- Layer 2 GENERAL event bus (pillar §5.4.3, rev 9 bf20ed0): "record
-- surroundings changed" outbox. First consumer: the semantic-layer embed
-- worker (event → context rebuild → immediate re-embed). Designed SHARED:
-- future consumers (e.g. dedup canonical re-election on verify events, P3)
-- read the same stream and keep their own cursor — add a
-- <consumer>_processed_at column or a cursor table then; v1 carries only the
-- embed consumer's column.
--
-- NOTE on ids: bigserial is deliberate and does NOT violate §5.1 invariant 1
-- ("no auto-increment ids") — that invariant binds RECORD identity (graph
-- nodes/edges). This table is service infrastructure (an outbox queue), not a
-- record type; it never migrates to Neo4j.

CREATE TABLE IF NOT EXISTS layer2_events (
  id                 bigserial PRIMARY KEY,
  event_type         text NOT NULL,      -- 'record_created' | 'surroundings_changed' | ...
  record_id          text NOT NULL,      -- the Layer 2 record whose surroundings changed
  detail             jsonb,              -- optional cause info ({source:'insertRelation', ...})
  created_at         timestamptz NOT NULL DEFAULT now(),
  embed_processed_at timestamptz         -- embed-worker consumer cursor (NULL = pending)
);
CREATE INDEX IF NOT EXISTS idx_l2_events_pending
  ON layer2_events (id) WHERE embed_processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_l2_events_record ON layer2_events (record_id);
