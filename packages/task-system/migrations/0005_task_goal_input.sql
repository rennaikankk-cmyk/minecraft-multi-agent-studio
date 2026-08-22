BEGIN;

ALTER TABLE studio_tasks
  ADD COLUMN IF NOT EXISTS task_input JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'studio_tasks'::regclass
      AND conname = 'studio_tasks_input_size_check'
  ) THEN
    ALTER TABLE studio_tasks
      ADD CONSTRAINT studio_tasks_input_size_check
      CHECK (
        task_input IS NULL
        -- jsonb::text adds formatting spaces; application input remains 32 KiB.
        OR octet_length(task_input::text) <= 65536
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS studio_tasks_type_status_updated_idx
  ON studio_tasks (task_type, status, updated_at DESC, task_id);

CREATE INDEX IF NOT EXISTS studio_tasks_history_created_idx
  ON studio_tasks (created_at DESC, task_id DESC);

CREATE INDEX IF NOT EXISTS studio_tasks_goal_bot_idx
  ON studio_tasks ((task_input ->> 'botId'), created_at DESC, task_id DESC)
  WHERE task_type = 'coordinator.goal' AND task_input IS NOT NULL;

COMMIT;
