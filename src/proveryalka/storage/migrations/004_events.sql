CREATE TABLE run_events (
 run_id TEXT NOT NULL REFERENCES runs(run_id), event_id INTEGER NOT NULL,
 event_json TEXT NOT NULL, PRIMARY KEY(run_id,event_id)
);
