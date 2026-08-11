BEGIN;

ALTER TABLE studio_task_outbox
  DROP CONSTRAINT IF EXISTS studio_task_outbox_status_check,
  ADD CONSTRAINT studio_task_outbox_status_check
    CHECK (status IN ('pending', 'claimed', 'delivered', 'failed'));

CREATE TEMPORARY TABLE studio_task_outbox_0004_failures
ON COMMIT DROP
AS
SELECT
  outbox.message_id,
  outbox.task_id,
  outbox.expected_revision,
  CASE
    WHEN (
      (jsonb_typeof(outbox.payload) = 'object') IS NOT TRUE
      OR (jsonb_typeof(outbox.payload -> 'schemaVersion') = 'string') IS NOT TRUE
      OR ((outbox.payload ->> 'schemaVersion') = '1.0') IS NOT TRUE
      OR (jsonb_typeof(outbox.payload -> 'type') = 'string') IS NOT TRUE
      OR ((outbox.payload ->> 'type') = outbox.type) IS NOT TRUE
      OR (jsonb_typeof(outbox.payload -> 'payload') = 'object') IS NOT TRUE
      OR (
        CASE
          WHEN jsonb_typeof(outbox.payload -> 'messageId') = 'string'
            AND (outbox.payload ->> 'messageId')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (outbox.payload ->> 'messageId')::uuid = outbox.message_id
          ELSE false
        END
      ) IS NOT TRUE
      OR (
        CASE
          WHEN jsonb_typeof(outbox.payload -> 'taskId') = 'string'
            AND (outbox.payload ->> 'taskId')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (outbox.payload ->> 'taskId')::uuid = outbox.task_id
          ELSE false
        END
      ) IS NOT TRUE
      OR (
        CASE
          WHEN jsonb_typeof(
            outbox.payload -> 'payload' -> 'expectedRevision'
          ) = 'number'
            THEN (
              (outbox.payload -> 'payload' ->> 'expectedRevision')::numeric
              = outbox.expected_revision
            )
          ELSE false
        END
      ) IS NOT TRUE
    ) THEN 'TASK_OUTBOX_RECORD_INVALID'
    ELSE 'TASK_OUTBOX_DELIVERY_EXHAUSTED'
  END AS reason_code
FROM studio_task_outbox AS outbox
WHERE outbox.status = 'failed'
   OR (jsonb_typeof(outbox.payload) = 'object') IS NOT TRUE
   OR (jsonb_typeof(outbox.payload -> 'schemaVersion') = 'string') IS NOT TRUE
   OR ((outbox.payload ->> 'schemaVersion') = '1.0') IS NOT TRUE
   OR (jsonb_typeof(outbox.payload -> 'type') = 'string') IS NOT TRUE
   OR ((outbox.payload ->> 'type') = outbox.type) IS NOT TRUE
   OR (jsonb_typeof(outbox.payload -> 'payload') = 'object') IS NOT TRUE
   OR (
     CASE
       WHEN jsonb_typeof(outbox.payload -> 'messageId') = 'string'
         AND (outbox.payload ->> 'messageId')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (outbox.payload ->> 'messageId')::uuid = outbox.message_id
       ELSE false
     END
   ) IS NOT TRUE
   OR (
     CASE
       WHEN jsonb_typeof(outbox.payload -> 'taskId') = 'string'
         AND (outbox.payload ->> 'taskId')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN (outbox.payload ->> 'taskId')::uuid = outbox.task_id
       ELSE false
     END
   ) IS NOT TRUE
   OR (
     CASE
       WHEN jsonb_typeof(
         outbox.payload -> 'payload' -> 'expectedRevision'
       ) = 'number'
         THEN (
           (outbox.payload -> 'payload' ->> 'expectedRevision')::numeric
           = outbox.expected_revision
         )
       ELSE false
     END
   ) IS NOT TRUE;

UPDATE studio_task_outbox AS outbox
SET status = 'failed',
    claimed_by = NULL,
    claim_expires_at = NULL,
    last_error = CASE
      WHEN failure.reason_code = 'TASK_OUTBOX_RECORD_INVALID'
        THEN failure.reason_code
      ELSE COALESCE(outbox.last_error, failure.reason_code)
    END,
    updated_at = clock_timestamp()
FROM studio_task_outbox_0004_failures AS failure
WHERE outbox.message_id = failure.message_id;

CREATE TEMPORARY TABLE studio_task_outbox_0004_task_transitions
ON COMMIT DROP
AS
SELECT
  failure.message_id,
  failure.task_id,
  failure.expected_revision,
  failure.reason_code,
  statement_timestamp() AS transitioned_at,
  CASE
    WHEN task.deadline IS NOT NULL
      AND task.deadline <= statement_timestamp()
      THEN 'expired'
    ELSE 'blocked'
  END AS to_status
FROM studio_task_outbox_0004_failures AS failure
JOIN studio_tasks AS task ON task.task_id = failure.task_id
WHERE task.status = 'queued'
  AND task.revision = failure.expected_revision;

UPDATE studio_tasks AS task
SET status = transition.to_status,
    failure_reason = transition.reason_code,
    revision = task.revision + 1,
    updated_at = transition.transitioned_at,
    finished_at = CASE
      WHEN transition.to_status = 'expired'
        THEN transition.transitioned_at
      ELSE NULL
    END
FROM studio_task_outbox_0004_task_transitions AS transition
WHERE task.task_id = transition.task_id
  AND task.status = 'queued'
  AND task.revision = transition.expected_revision;

INSERT INTO studio_task_history (
  operation_id,
  operation_fingerprint,
  task_id,
  event_type,
  from_status,
  to_status,
  actor_id,
  reason_code,
  task_snapshot,
  created_at
)
SELECT
  transition.message_id,
  md5('task-outbox-0004:' || transition.message_id::text)
    || md5('task-outbox-0004:v1:' || transition.message_id::text),
  task.task_id,
  CASE
    WHEN transition.to_status = 'expired'
      THEN 'task.dispatch-expired'
    ELSE 'task.dispatch-blocked'
  END,
  'queued',
  transition.to_status,
  'migration-0004',
  transition.reason_code,
  jsonb_build_object(
    'schemaVersion', task.schema_version,
    'taskId', task.task_id::text,
    'idempotencyScope', task.idempotency_scope,
    'idempotencyKey', task.idempotency_key,
    'requestFingerprint', task.request_fingerprint,
    'taskType', task.task_type,
    'handlerVersion', task.handler_version,
    'executionIdempotent', task.execution_idempotent,
    'title', task.title,
    'description', task.description,
    'priority', task.priority,
    'status', task.status,
    'dispatchBotId', task.dispatch_bot_id,
    'assignedBotId', task.assigned_bot_id,
    'requiredSkills', task.required_skills,
    'requiredItems', task.required_items,
    'target', task.target,
    'dependencyIds', COALESCE(
      (
        SELECT jsonb_agg(
          dependency.dependency_task_id::text
          ORDER BY dependency.dependency_task_id
        )
        FROM studio_task_dependencies AS dependency
        WHERE dependency.task_id = task.task_id
      ),
      '[]'::jsonb
    ),
    'parentTaskId', task.parent_task_id,
    'createdAt', task.created_at,
    'updatedAt', task.updated_at,
    'startedAt', task.started_at,
    'finishedAt', task.finished_at,
    'deadline', task.deadline,
    'timeoutMs', task.timeout_ms,
    'retryCount', task.retry_count,
    'maxRetries', task.max_retries,
    'leaseOwner', task.lease_owner,
    'leaseExpiresAt', task.lease_expires_at,
    'riskLevel', task.risk_level,
    'failureReason', task.failure_reason,
    'result', task.result,
    'evidence', task.evidence,
    'traceId', task.trace_id,
    'revision', task.revision
  ),
  transition.transitioned_at
FROM studio_task_outbox_0004_task_transitions AS transition
JOIN studio_tasks AS task ON task.task_id = transition.task_id
WHERE task.revision = transition.expected_revision + 1
  AND task.status = transition.to_status;

UPDATE studio_task_outbox
SET last_error = 'TASK_OUTBOX_RECORD_INVALID',
    updated_at = clock_timestamp()
WHERE status = 'failed' AND last_error IS NULL;

ALTER TABLE studio_task_outbox
  DROP CONSTRAINT IF EXISTS studio_task_outbox_payload_object_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_payload_schema_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_payload_type_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_payload_body_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_message_id_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_task_id_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_revision_payload_check,
  DROP CONSTRAINT IF EXISTS studio_task_outbox_failed_error_check,
  ADD CONSTRAINT studio_task_outbox_failed_error_check
    CHECK ((status <> 'failed' OR last_error IS NOT NULL) IS TRUE),
  ADD CONSTRAINT studio_task_outbox_payload_object_check
    CHECK ((status = 'failed' OR jsonb_typeof(payload) = 'object') IS TRUE),
  ADD CONSTRAINT studio_task_outbox_payload_schema_check
    CHECK (
      (
        status = 'failed'
        OR (
          jsonb_typeof(payload -> 'schemaVersion') = 'string'
          AND (payload ->> 'schemaVersion') = '1.0'
        )
      ) IS TRUE
    ),
  ADD CONSTRAINT studio_task_outbox_payload_type_check
    CHECK (
      (
        status = 'failed'
        OR (
          jsonb_typeof(payload -> 'type') = 'string'
          AND (payload ->> 'type') = type
        )
      ) IS TRUE
    ),
  ADD CONSTRAINT studio_task_outbox_payload_body_check
    CHECK (
      (status = 'failed' OR jsonb_typeof(payload -> 'payload') = 'object')
      IS TRUE
    ),
  ADD CONSTRAINT studio_task_outbox_message_id_check
    CHECK (
      CASE
        WHEN status = 'failed' THEN true
        WHEN jsonb_typeof(payload -> 'messageId') = 'string'
          AND (payload ->> 'messageId')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (payload ->> 'messageId')::uuid = message_id
        ELSE false
      END
    ),
  ADD CONSTRAINT studio_task_outbox_task_id_check
    CHECK (
      CASE
        WHEN status = 'failed' THEN true
        WHEN jsonb_typeof(payload -> 'taskId') = 'string'
          AND (payload ->> 'taskId')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (payload ->> 'taskId')::uuid = task_id
        ELSE false
      END
    ),
  ADD CONSTRAINT studio_task_outbox_revision_payload_check
    CHECK (
      CASE
        WHEN status = 'failed' THEN true
        WHEN jsonb_typeof(payload -> 'payload' -> 'expectedRevision') = 'number'
          THEN (
            (payload -> 'payload' ->> 'expectedRevision')::numeric
            = expected_revision
          )
        ELSE false
      END
    );

CREATE INDEX IF NOT EXISTS studio_task_outbox_expired_claim_idx
  ON studio_task_outbox (claim_expires_at, message_id)
  WHERE status = 'claimed';

COMMIT;
