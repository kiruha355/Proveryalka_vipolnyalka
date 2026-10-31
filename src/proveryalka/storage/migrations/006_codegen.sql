CREATE TABLE IF NOT EXISTS codegen_generations (
 generation_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id),
 model_id TEXT NOT NULL REFERENCES models(id),
 version_id TEXT NOT NULL REFERENCES model_versions(id),
 version_number INTEGER NOT NULL CHECK(version_number > 0),
 spec_hash TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 target TEXT NOT NULL,
 generator_version TEXT NOT NULL,
 record_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codegen_files (
 generation_id TEXT NOT NULL REFERENCES codegen_generations(generation_id),
 path TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size >= 0),
 sha256 TEXT NOT NULL,
 entry_json TEXT NOT NULL,
 content BLOB NOT NULL,
 PRIMARY KEY(generation_id, path)
);
CREATE TABLE IF NOT EXISTS codegen_test_runs (
 test_run_id TEXT PRIMARY KEY,
 generation_id TEXT NOT NULL REFERENCES codegen_generations(generation_id),
 session_id TEXT NOT NULL REFERENCES sessions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed','timeout','engine_unavailable','cancelled','error')),
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 timeout_seconds REAL NOT NULL,
 result_json TEXT,
 log TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 started_at TEXT,
 finished_at TEXT
);
CREATE INDEX IF NOT EXISTS codegen_generations_version ON codegen_generations(version_id, created_at);
CREATE INDEX IF NOT EXISTS codegen_generations_session ON codegen_generations(session_id, created_at);
CREATE INDEX IF NOT EXISTS codegen_test_runs_generation ON codegen_test_runs(generation_id, created_at);
CREATE INDEX IF NOT EXISTS codegen_test_runs_status ON codegen_test_runs(status)
