BEGIN;

CREATE TABLE IF NOT EXISTS studio_world_memory (
  memory_id BIGSERIAL PRIMARY KEY,
  server_profile_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  z DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  stale_after_ms BIGINT NOT NULL,
  payload JSONB NOT NULL,
  CONSTRAINT studio_world_memory_server_profile_check
    CHECK (char_length(server_profile_id) BETWEEN 1 AND 128),
  CONSTRAINT studio_world_memory_dimension_check
    CHECK (char_length(dimension) BETWEEN 1 AND 128),
  CONSTRAINT studio_world_memory_coordinate_check
    CHECK (
      x = x AND y = y AND z = z
      AND x <> 'Infinity'::double precision
      AND x <> '-Infinity'::double precision
      AND x <> 'NaN'::double precision
      AND y <> 'Infinity'::double precision
      AND y <> '-Infinity'::double precision
      AND y <> 'NaN'::double precision
      AND z <> 'Infinity'::double precision
      AND z <> '-Infinity'::double precision
      AND z <> 'NaN'::double precision
    ),
  CONSTRAINT studio_world_memory_kind_check
    CHECK (kind IN (
      'ORE_VEIN', 'SAFE_SITE', 'OWN_STASH', 'OWN_HIDEOUT',
      'VILLAGER', 'HIGHWAY_NODE', 'HAZARD', 'PORTAL_SUSPECT',
      'BLUEPRINT_ANCHOR'
    )),
  CONSTRAINT studio_world_memory_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT studio_world_memory_stale_after_check
    CHECK (stale_after_ms BETWEEN 1 AND 9007199254740991),
  CONSTRAINT studio_world_memory_payload_check
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS studio_world_memory_scope_kind_idx
  ON studio_world_memory (server_profile_id, kind, memory_id);

CREATE INDEX IF NOT EXISTS studio_world_memory_scope_dimension_idx
  ON studio_world_memory (server_profile_id, dimension, memory_id);

CREATE OR REPLACE FUNCTION studio_reject_world_memory_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'world memory is append-only';
END;
$$;

DROP TRIGGER IF EXISTS studio_world_memory_no_update_delete
  ON studio_world_memory;
CREATE TRIGGER studio_world_memory_no_update_delete
BEFORE UPDATE OR DELETE ON studio_world_memory
FOR EACH ROW EXECUTE FUNCTION studio_reject_world_memory_mutation();

COMMIT;
