-- Sources JSONB: unified storage for all source files (PDF, LaTeX, etc.)
-- Example: {"pdf": {"path": "...pdf", "size": 2458000}, "latex": {"path": ".../source/", "rootTex": "main.tex", "manifest": true}}
ALTER TABLE documents ADD COLUMN sources JSONB DEFAULT '{}';

-- source_format: what parser was actually used to process this document
-- 'pdf' = GROBID/Mathpix, 'latex' = LaTeX source parser
ALTER TABLE documents ADD COLUMN source_format TEXT;

-- Backfill existing documents: all current docs were parsed from PDF
UPDATE documents SET source_format = 'pdf' WHERE source_format IS NULL AND status IN ('ready', 'failed');
