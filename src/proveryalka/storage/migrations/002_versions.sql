CREATE TABLE models (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL,
 UNIQUE(id,session_id)
);
CREATE TABLE model_versions (
 id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id), number INTEGER NOT NULL CHECK(number>0),
 parent_id TEXT, spec TEXT NOT NULL, spec_hash TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
 UNIQUE(model_id,number), UNIQUE(id,model_id),
 FOREIGN KEY(parent_id,model_id) REFERENCES model_versions(id,model_id)
);
