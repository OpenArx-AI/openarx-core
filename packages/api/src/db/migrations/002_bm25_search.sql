-- BM25 full-text search: tsvector column + GIN index + auto-update trigger

ALTER TABLE chunks ADD COLUMN search_vector tsvector;

UPDATE chunks SET search_vector = to_tsvector('english', content);

CREATE INDEX idx_chunks_search_vector ON chunks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_search_vector_update();
