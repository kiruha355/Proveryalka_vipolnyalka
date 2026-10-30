CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('analyzer', 'debugger', 'overview', 'codegen')),
    created_at TEXT NOT NULL,
    next_message INTEGER NOT NULL DEFAULT 1,
    next_requirement INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    message_data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, sequence)
);
CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL CHECK(kind = 'text'),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(id, session_id)
);
CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    source_id TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    text TEXT NOT NULL CHECK(length(trim(text)) > 0),
    UNIQUE(session_id, number),
    FOREIGN KEY(source_id, session_id) REFERENCES sources(id, session_id)
);
CREATE TABLE idempotency (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY(scope, key)
);
CREATE INDEX sources_session ON sources(session_id, created_at, id);
CREATE INDEX sessions_created ON sessions(created_at, id);
