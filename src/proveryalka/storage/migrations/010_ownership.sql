ALTER TABLE sessions ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX sessions_owner ON sessions(owner_id, created_at);
CREATE TABLE mcp_grants (
 token_hash TEXT NOT NULL REFERENCES user_sessions(token_hash) ON DELETE CASCADE,
 model_id TEXT NOT NULL REFERENCES models(id),
 PRIMARY KEY(token_hash,model_id)
);
