CREATE TABLE image_sources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    metadata_json TEXT NOT NULL,
    canonical_png BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX image_sources_session ON image_sources(session_id, created_at, id);
CREATE TABLE image_analyses (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES image_sources(id),
    request_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed')),
    response_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source_id, request_key)
);
