-- Translation support: store original non-English title/abstract
-- Primary fields (title, abstract, structured_content.sections) are always English.
-- When language != 'en', originals are saved here before translation.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_title TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_abstract TEXT;
