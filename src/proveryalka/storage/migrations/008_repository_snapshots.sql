CREATE TABLE IF NOT EXISTS repository_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    remote_url TEXT NOT NULL,
    commit_sha TEXT NOT NULL CHECK(length(commit_sha) = 40),
    manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
    parent_snapshot_id TEXT REFERENCES repository_snapshots(id),
    created_at TEXT NOT NULL,
    files_json TEXT NOT NULL,
    excluded_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    UNIQUE(id, session_id)
);
CREATE TABLE IF NOT EXISTS repository_files (
    snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id),
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, path)
);
CREATE TABLE IF NOT EXISTS repository_source_contexts (
    source_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    selection_json TEXT NOT NULL,
    context_sha256 TEXT NOT NULL,
    excerpts_json TEXT NOT NULL,
    FOREIGN KEY(source_id, session_id) REFERENCES sources(id, session_id),
    FOREIGN KEY(snapshot_id, session_id) REFERENCES repository_snapshots(id, session_id)
);
CREATE INDEX IF NOT EXISTS repository_snapshots_session ON repository_snapshots(session_id, created_at, id);
