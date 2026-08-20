BEGIN;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE OR REPLACE FUNCTION studio_text_array_is_unique(values_to_check TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(values_to_check) = COUNT(DISTINCT value)
  FROM unnest(values_to_check) AS value;
$$;

CREATE OR REPLACE FUNCTION studio_text_array_matches(
  values_to_check TEXT[],
  match_pattern TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(bool_and(value ~ match_pattern), true)
  FROM unnest(values_to_check) AS value;
$$;

CREATE TABLE IF NOT EXISTS studio_world_memory (
  memory_id UUID PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  operation_id UUID NOT NULL UNIQUE,
  operation_fingerprint CHAR(64) NOT NULL,
  server_profile_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  position_x DOUBLE PRECISION NOT NULL,
  position_y DOUBLE PRECISION NOT NULL,
  position_z DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  confidence DOUBLE PRECISION NOT NULL,
  visibility TEXT NOT NULL,
  allowed_subject_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  model_access BOOLEAN NOT NULL DEFAULT false,
  source_bot_id TEXT NOT NULL,
  source_task_id TEXT,
  trace_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  supersedes_memory_id UUID,
  embedding_model TEXT,
  embedding VECTOR,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT studio_world_memory_identity_unique
    UNIQUE (memory_id, server_profile_id, dimension),
  CONSTRAINT studio_world_memory_supersedes_same_world_fk
    FOREIGN KEY (supersedes_memory_id, server_profile_id, dimension)
    REFERENCES studio_world_memory (memory_id, server_profile_id, dimension)
    ON DELETE RESTRICT,
  CONSTRAINT studio_world_memory_schema_check
    CHECK (schema_version = '1.0'),
  CONSTRAINT studio_world_memory_fingerprint_check
    CHECK (operation_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT studio_world_memory_server_check
    CHECK (server_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT studio_world_memory_dimension_check
    CHECK (dimension ~ '^[a-z0-9_.-]+:[a-z0-9_./-]+$' AND length(dimension) <= 128),
  CONSTRAINT studio_world_memory_position_check
    CHECK (
      position_x BETWEEN -30000000 AND 30000000
      AND position_y BETWEEN -4096 AND 4096
      AND position_z BETWEEN -30000000 AND 30000000
    ),
  CONSTRAINT studio_world_memory_kind_check
    CHECK (kind IN (
      'base', 'hazard', 'landmark', 'player_activity',
      'portal', 'resource', 'route', 'storage'
    )),
  CONSTRAINT studio_world_memory_summary_check
    CHECK (length(btrim(summary)) BETWEEN 1 AND 1024),
  CONSTRAINT studio_world_memory_tags_check
    CHECK (
      cardinality(tags) <= 32
      AND studio_text_array_is_unique(tags)
      AND studio_text_array_matches(
        tags,
        '^[a-z0-9][a-z0-9._:-]{0,63}$'
      )
    ),
  CONSTRAINT studio_world_memory_confidence_check
    CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT studio_world_memory_visibility_check
    CHECK (visibility IN ('team', 'restricted')),
  CONSTRAINT studio_world_memory_acl_check
    CHECK (
      cardinality(allowed_subject_ids) <= 64
      AND studio_text_array_is_unique(allowed_subject_ids)
      AND studio_text_array_matches(
        allowed_subject_ids,
        '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      )
      AND (
        (visibility = 'team' AND cardinality(allowed_subject_ids) = 0)
        OR
        (visibility = 'restricted' AND source_bot_id = ANY(allowed_subject_ids))
      )
    ),
  CONSTRAINT studio_world_memory_model_access_check
    CHECK (
      NOT model_access
      OR (
        visibility = 'team'
        AND kind NOT IN ('base', 'storage', 'player_activity')
      )
    ),
  CONSTRAINT studio_world_memory_expiry_check
    CHECK (expires_at IS NULL OR expires_at > observed_at),
  CONSTRAINT studio_world_memory_source_identifiers_check
    CHECK (
      source_bot_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND (source_task_id IS NULL OR source_task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      AND trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT studio_world_memory_no_self_supersede_check
    CHECK (supersedes_memory_id IS NULL OR supersedes_memory_id <> memory_id),
  CONSTRAINT studio_world_memory_embedding_pair_check
    CHECK (
      (embedding_model IS NULL AND embedding IS NULL)
      OR
      (
        embedding_model IS NOT NULL
        AND embedding IS NOT NULL
        AND embedding_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$'
        AND vector_dims(embedding) BETWEEN 1 AND 2000
      )
    )
);

CREATE INDEX IF NOT EXISTS studio_world_memory_world_observed_idx
  ON studio_world_memory (
    server_profile_id,
    dimension,
    observed_at DESC,
    memory_id
  );

CREATE INDEX IF NOT EXISTS studio_world_memory_active_world_idx
  ON studio_world_memory (server_profile_id, dimension, kind, confidence DESC)
  WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS studio_world_memory_tags_idx
  ON studio_world_memory USING GIN (tags);

CREATE INDEX IF NOT EXISTS studio_world_memory_source_idx
  ON studio_world_memory (source_bot_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS studio_world_memory_supersedes_idx
  ON studio_world_memory (supersedes_memory_id)
  WHERE supersedes_memory_id IS NOT NULL;

CREATE OR REPLACE FUNCTION studio_reject_world_memory_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'studio world memory is immutable; supersede it with a new record';
END;
$$;

DROP TRIGGER IF EXISTS studio_world_memory_immutable
  ON studio_world_memory;
CREATE TRIGGER studio_world_memory_immutable
BEFORE UPDATE OR DELETE ON studio_world_memory
FOR EACH ROW EXECUTE FUNCTION studio_reject_world_memory_mutation();

COMMIT;
