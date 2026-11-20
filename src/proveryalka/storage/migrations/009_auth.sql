CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE user_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL, created REAL NOT NULL, kind TEXT NOT NULL);
CREATE INDEX user_sessions_user ON user_sessions(user_id);
CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires REAL NOT NULL);
