import { describe, expect, it } from "vitest";
import { InMemoryFacilityLeaseAuthority } from "../src/facility-lease.js";

describe("facility fencing lease", () => {
  it("prevents a competing owner and advances fencing tokens after expiry", () => {
    const authority = new InMemoryFacilityLeaseAuthority();
    const first = authority.acquire({ facilityId: "iron-1", ownerId: "coord-a", ttlMs: 1_000 }, 0)!;
    expect(authority.acquire({ facilityId: "iron-1", ownerId: "coord-b", ttlMs: 1_000 }, 500)).toBeNull();
    const second = authority.acquire({ facilityId: "iron-1", ownerId: "coord-b", ttlMs: 1_000 }, 1_001)!;
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(authority.isCurrent(first, 1_001)).toBe(false);
    expect(authority.release(first, 1_001)).toBe(false);
    expect(authority.release(second, 1_500)).toBe(true);
  });
});
