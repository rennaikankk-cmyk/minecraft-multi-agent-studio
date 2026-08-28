BEGIN;

CREATE TABLE IF NOT EXISTS studio_task_executions (
  -- Control-plane goal executions are independent from the leased task queue.
  -- Their externally-issued UUID is not guaranteed to have a studio_tasks row.
  task_id UUID PRIMARY KEY,
  bot_id TEXT NOT NULL,
  execution_state TEXT NOT NULL,
  revision BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT studio_task_executions_state_check CHECK (
    execution_state IN ('PRECHECK', 'PLAN', 'EXECUTE', 'VERIFY', 'SUCCESS', 'RECOVER', 'REPLAN', 'ABORT')
  ),
  CONSTRAINT studio_task_executions_revision_check CHECK (revision >= 0),
  CONSTRAINT studio_task_executions_snapshot_object_check CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT studio_task_executions_snapshot_schema_check CHECK (snapshot ->> 'schemaVersion' = '1.0'),
  CONSTRAINT studio_task_executions_snapshot_task_check CHECK ((snapshot ->> 'taskId')::uuid = task_id),
  CONSTRAINT studio_task_executions_snapshot_bot_check CHECK (snapshot ->> 'botId' = bot_id),
  CONSTRAINT studio_task_executions_snapshot_state_check CHECK (snapshot ->> 'state' = execution_state),
  CONSTRAINT studio_task_executions_snapshot_revision_check CHECK ((snapshot ->> 'revision')::bigint = revision),
  -- Missing fields are valid legacy snapshots and normalize to null in code.
  CONSTRAINT studio_task_executions_snapshot_owner_lease_check CHECK (
    (snapshot ->> 'executionOwner' IS NULL) =
    (snapshot ->> 'executionLeaseExpiresAt' IS NULL)
  ),
  CONSTRAINT studio_task_executions_terminal_owner_check CHECK (
    execution_state NOT IN ('SUCCESS', 'ABORT') OR
    (
      snapshot ->> 'executionOwner' IS NULL AND
      snapshot ->> 'executionLeaseExpiresAt' IS NULL
    )
  )
);

-- Remove the constraint if an earlier development draft of this unapplied
-- migration created it before the execution/dispatch boundary was corrected.
ALTER TABLE studio_task_executions
  DROP CONSTRAINT IF EXISTS studio_task_executions_task_id_fkey;

CREATE INDEX IF NOT EXISTS studio_task_executions_bot_state_idx
  ON studio_task_executions (bot_id, execution_state, updated_at DESC);

COMMIT;
