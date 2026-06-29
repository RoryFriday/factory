-- Factory control-plane schema.
-- Applied automatically on container start via docker-entrypoint-initdb.d.

CREATE TABLE IF NOT EXISTS pbi (
    id SERIAL PRIMARY KEY,
    feature TEXT NOT NULL,              -- e.g. 'rate-limiting', matches specs/<feature>/
    pbi_number TEXT NOT NULL,           -- e.g. 'PBI-000', 'PBI-001'
    file_path TEXT NOT NULL,            -- e.g. 'tasks/rate-limiting/PBI-001.md'
    depends_on TEXT,                    -- e.g. 'PBI-000', nullable
    status TEXT NOT NULL DEFAULT 'pending',
        -- pending | queued | running | gates_running | passed | failed | blocked
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (feature, pbi_number)
);

CREATE TABLE IF NOT EXISTS run (
    id SERIAL PRIMARY KEY,
    pbi_id INTEGER NOT NULL REFERENCES pbi(id),
    container_id TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed | timed_out
    agent_summary TEXT,                       -- the agent's own final text summary
    raw_log_path TEXT                         -- path to the full rpc event log, on disk
);

CREATE TABLE IF NOT EXISTS gate_result (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id),
    gate_type TEXT NOT NULL,            -- 'build' | 'test' | 'lint' | 'compose_test'
    status TEXT NOT NULL,               -- 'passed' | 'failed'
    detail TEXT,                        -- captured stdout/stderr, truncated if huge
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commit_log (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id),
    sha TEXT NOT NULL,
    message TEXT,
    step_label TEXT,                    -- e.g. 'scaffold', 'feature', 'tests', 'wiring'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pbi_status ON pbi(status);
CREATE INDEX IF NOT EXISTS idx_run_pbi_id ON run(pbi_id);
CREATE INDEX IF NOT EXISTS idx_gate_result_run_id ON gate_result(run_id);