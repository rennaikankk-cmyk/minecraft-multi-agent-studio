BEGIN;

-- Cross-Coordinator facility execution lease. fencing_token changes on every
-- successful acquisition so stale workers cannot commit side effects.
CREATE TABLE IF NOT EXISTS studio_facility_leases (
  facility_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  expires_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS studio_facility_leases_expiry_idx
  ON studio_facility_leases (expires_at_ms);

COMMIT;
