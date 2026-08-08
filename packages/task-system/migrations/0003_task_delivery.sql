BEGIN;

ALTER TABLE studio_tasks
  ADD COLUMN IF NOT EXISTS dispatch_bot_id TEXT;

CREATE INDEX IF NOT EXISTS studio_tasks_dispatch_bot_idx
  ON studio_tasks (dispatch_bot_id, status, priority DESC, created_at ASC)
  WHERE dispatch_bot_id IS NOT NULL AND status = 'queued';

CREATE TABLE IF NOT EXISTS studio_task_outbox (
  message_id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  expected_revision BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL,
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT studio_task_outbox_type_check
    CHECK (type = 'task.dispatch.v1'),
  CONSTRAINT studio_task_outbox_status_check
    CHECK (status IN ('pending', 'claimed', 'delivered')),
  CONSTRAINT studio_task_outbox_revision_check
    CHECK (expected_revision >= 0),
  CONSTRAINT studio_task_outbox_attempt_check
    CHECK (attempt_count BETWEEN 0 AND 1000),
  CONSTRAINT studio_task_outbox_claim_pair_check
    CHECK (
      (claimed_by IS NULL AND claim_expires_at IS NULL)
      OR (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
    ),
  CONSTRAINT studio_task_outbox_status_claim_check
    CHECK (
      (status = 'claimed' AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
      OR (status <> 'claimed' AND claimed_by IS NULL AND claim_expires_at IS NULL)
    ),
  CONSTRAINT studio_task_outbox_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT studio_task_outbox_message_id_check
    CHECK ((payload ->> 'messageId')::uuid = message_id),
  CONSTRAINT studio_task_outbox_task_id_check
    CHECK ((payload ->> 'taskId')::uuid = task_id),
  CONSTRAINT studio_task_outbox_revision_payload_check
    CHECK (((payload -> 'payload' ->> 'expectedRevision')::bigint) = expected_revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_task_outbox_revision_unique
  ON studio_task_outbox (task_id, expected_revision, type);

CREATE INDEX IF NOT EXISTS studio_task_outbox_claim_idx
  ON studio_task_outbox (available_at, message_id)
  WHERE status IN ('pending', 'delivered');

CREATE TABLE IF NOT EXISTS studio_task_cancellation_requests (
  request_id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES studio_tasks(task_id) ON DELETE RESTRICT,
  operation_id UUID NOT NULL,
  operation_fingerprint CHAR(64) NOT NULL,
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  CONSTRAINT studio_task_cancel_request_fingerprint_check
    CHECK (operation_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT studio_task_cancel_request_ack_pair_check
    CHECK (
      (acknowledged_at IS NULL AND acknowledged_by IS NULL)
      OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_task_cancellation_operation_unique
  ON studio_task_cancellation_requests (operation_id);

CREATE UNIQUE INDEX IF NOT EXISTS studio_task_cancellation_task_unique
  ON studio_task_cancellation_requests (task_id);

CREATE INDEX IF NOT EXISTS studio_task_cancellation_pending_idx
  ON studio_task_cancellation_requests (task_id, requested_at)
  WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION studio_reject_task_outbox_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.message_id <> NEW.message_id
     OR OLD.task_id <> NEW.task_id
     OR OLD.expected_revision <> NEW.expected_revision
     OR OLD.type <> NEW.type
     OR OLD.payload <> NEW.payload
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'task dispatch outbox identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS studio_task_outbox_identity_immutable
  ON studio_task_outbox;
CREATE TRIGGER studio_task_outbox_identity_immutable
BEFORE UPDATE ON studio_task_outbox
FOR EACH ROW EXECUTE FUNCTION studio_reject_task_outbox_identity_mutation();

COMMIT;
