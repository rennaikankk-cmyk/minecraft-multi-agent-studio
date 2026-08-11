BEGIN;

CREATE TABLE IF NOT EXISTS studio_tasks (
  task_id UUID PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  task_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority SMALLINT NOT NULL,
  status TEXT NOT NULL,
  assigned_bot_id TEXT,
  required_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  target JSONB,
  parent_task_id UUID REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  deadline TIMESTAMPTZ,
  timeout_ms INTEGER NOT NULL,
  retry_count SMALLINT NOT NULL DEFAULT 0,
  max_retries SMALLINT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  risk_level TEXT NOT NULL,
  failure_reason TEXT,
  result JSONB,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  trace_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT studio_tasks_idempotency_unique
    UNIQUE (idempotency_scope, idempotency_key),
  CONSTRAINT studio_tasks_schema_version_check
    CHECK (schema_version = '1.0'),
  CONSTRAINT studio_tasks_fingerprint_check
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT studio_tasks_priority_check
    CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT studio_tasks_status_check
    CHECK (status IN (
      'queued', 'assigned', 'running', 'blocked', 'waiting',
      'paused', 'completed', 'failed', 'cancelled', 'expired'
    )),
  CONSTRAINT studio_tasks_timeout_check
    CHECK (timeout_ms BETWEEN 1000 AND 86400000),
  CONSTRAINT studio_tasks_retry_check
    CHECK (
      retry_count BETWEEN 0 AND 10
      AND max_retries BETWEEN 0 AND 10
      AND retry_count <= max_retries
    ),
  CONSTRAINT studio_tasks_risk_check
    CHECK (risk_level IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  CONSTRAINT studio_tasks_lease_pair_check
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT studio_tasks_revision_check CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS studio_task_dependencies (
  task_id UUID NOT NULL REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  dependency_task_id UUID NOT NULL REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, dependency_task_id),
  CONSTRAINT studio_task_dependencies_no_self_check
    CHECK (task_id <> dependency_task_id)
);

CREATE TABLE IF NOT EXISTS studio_task_history (
  operation_id UUID PRIMARY KEY,
  operation_fingerprint CHAR(64) NOT NULL,
  task_id UUID NOT NULL REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  task_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT studio_task_history_fingerprint_check
    CHECK (operation_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS studio_tasks_ready_queue_idx
  ON studio_tasks (status, priority DESC, created_at ASC)
  WHERE status IN ('queued', 'waiting', 'blocked');

CREATE INDEX IF NOT EXISTS studio_tasks_lease_expiry_idx
  ON studio_tasks (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS studio_tasks_assigned_bot_idx
  ON studio_tasks (assigned_bot_id, status)
  WHERE assigned_bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS studio_task_dependencies_dependency_idx
  ON studio_task_dependencies (dependency_task_id);

CREATE INDEX IF NOT EXISTS studio_task_history_task_created_idx
  ON studio_task_history (task_id, created_at ASC);

CREATE OR REPLACE FUNCTION studio_reject_task_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'studio tasks are append-history records and cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS studio_tasks_no_delete ON studio_tasks;
CREATE TRIGGER studio_tasks_no_delete
BEFORE DELETE ON studio_tasks
FOR EACH ROW EXECUTE FUNCTION studio_reject_task_delete();

CREATE OR REPLACE FUNCTION studio_reject_task_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'studio task history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS studio_task_history_append_only
  ON studio_task_history;
CREATE TRIGGER studio_task_history_append_only
BEFORE UPDATE OR DELETE ON studio_task_history
FOR EACH ROW EXECUTE FUNCTION studio_reject_task_history_mutation();

COMMIT;
