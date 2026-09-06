BEGIN;

CREATE TABLE IF NOT EXISTS studio_composite_tasks (
  task_id UUID PRIMARY KEY,
  task JSONB NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS studio_composite_tasks_updated_idx
  ON studio_composite_tasks (updated_at_ms);

COMMIT;
