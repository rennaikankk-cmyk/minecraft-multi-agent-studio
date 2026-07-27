BEGIN;

ALTER TABLE studio_tasks
  ADD COLUMN IF NOT EXISTS handler_version TEXT NOT NULL DEFAULT '0.0.0',
  ADD COLUMN IF NOT EXISTS execution_idempotent BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'studio_tasks'::regclass
      AND conname = 'studio_tasks_handler_version_check'
  ) THEN
    ALTER TABLE studio_tasks
      ADD CONSTRAINT studio_tasks_handler_version_check
      CHECK (handler_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$');
  END IF;
END;
$$;

DROP INDEX IF EXISTS studio_tasks_ready_queue_idx;

CREATE INDEX studio_tasks_ready_queue_idx
  ON studio_tasks (priority DESC, created_at ASC)
  WHERE status = 'queued';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'studio_tasks'::regclass
      AND conname = 'studio_tasks_status_lease_consistency_check'
  ) THEN
    ALTER TABLE studio_tasks
      ADD CONSTRAINT studio_tasks_status_lease_consistency_check
      CHECK (
        (
          status IN ('assigned', 'running')
          AND assigned_bot_id IS NOT NULL
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
        OR
        (
          status NOT IN ('assigned', 'running')
          AND assigned_bot_id IS NULL
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
        )
      );
  END IF;
END;
$$;

COMMIT;
