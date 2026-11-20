CREATE TABLE git_connections (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 remote_url TEXT NOT NULL,
 secret BLOB,
 created_at REAL NOT NULL,
 expires_at REAL NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0,
 last_checked_at REAL,
 last_error TEXT,
 access TEXT NOT NULL CHECK(access='read')
);
CREATE INDEX git_connections_owner ON git_connections(owner_id,created_at);
