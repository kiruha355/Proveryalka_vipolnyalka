ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(run_id);
ALTER TABLE runs ADD COLUMN explain INTEGER NOT NULL DEFAULT 0;
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE TABLE source_documents (
 source_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
 filename TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('txt','md','docx')),
 media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
 sha256 TEXT NOT NULL, characters INTEGER NOT NULL CHECK(characters > 0), created_at TEXT NOT NULL,
 FOREIGN KEY(source_id, session_id) REFERENCES sources(id, session_id)
);
