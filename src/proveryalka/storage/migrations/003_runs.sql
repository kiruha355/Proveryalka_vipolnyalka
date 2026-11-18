CREATE TABLE runs (
 run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
 version_id TEXT REFERENCES model_versions(id), kind TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','cancelled','completed','failed')),
 request_json TEXT NOT NULL, result_json TEXT, error_code TEXT, artifacts INTEGER NOT NULL DEFAULT 0
);
