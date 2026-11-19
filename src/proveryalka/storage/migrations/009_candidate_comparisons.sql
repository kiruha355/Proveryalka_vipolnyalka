CREATE TABLE IF NOT EXISTS codegen_candidate_comparisons (
 test_run_id TEXT PRIMARY KEY REFERENCES codegen_test_runs(test_run_id),
 snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id),
 comparison_json TEXT NOT NULL
);
