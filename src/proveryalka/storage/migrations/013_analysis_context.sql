CREATE TABLE IF NOT EXISTS image_source_contexts (
    source_id TEXT PRIMARY KEY REFERENCES sources(id),
    analysis_id TEXT NOT NULL UNIQUE REFERENCES image_analyses(id),
    session_id TEXT NOT NULL REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS image_source_contexts_session ON image_source_contexts(session_id);
CREATE TABLE IF NOT EXISTS version_reviews (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    version_id TEXT NOT NULL REFERENCES model_versions(id),
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS version_reviews_version ON version_reviews(version_id, created_at);
