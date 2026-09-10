export type BlockPosition = Readonly<{ x: number; y: number; z: number }>;

/**
 * 协议包解析（block change / digging ack）与共享小工具（从 mineflayer-client.ts 拆出，2026-09-10 结构拆分批次 5）。
 */
export type AuthoritativeBlockUpdate = Readonly<{
  position: BlockPosition;
  stateId: number;
}>;

export function blockPositionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseBlockChangePacket(packet: unknown): AuthoritativeBlockUpdate | null {
  const record = asRecord(packet);
  const location = asRecord(record?.location);
  const x = finiteNumber(location?.x);
  const y = finiteNumber(location?.y);
  const z = finiteNumber(location?.z);
  const stateId = finiteNumber(record?.type);
  if (x === null || y === null || z === null || stateId === null) return null;
  return { position: { x, y, z }, stateId };
}

/**
 * Decode one packed section record: `blockStateId << 12 | localX << 8 | localZ << 4 | localY`.
 *
 * Division rather than bitwise shifts: a state ID above 524287 pushes the packed
 * value past 2^31, where JavaScript's bitwise operators would truncate to 32
 * bits and silently produce a different block. `varlong` records also decode to
 * a BigInt, which bitwise operators reject outright.
 */
function packedSectionRecord(value: unknown): Readonly<{
  localX: number;
  localY: number;
  localZ: number;
  stateId: number;
}> | null {
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : finiteNumber(value);
  if (
    numeric === null ||
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric < 0
  ) {
    return null;
  }
  const packedPosition = numeric % 4096;
  return {
    localX: Math.floor(packedPosition / 256) % 16,
    localZ: Math.floor(packedPosition / 16) % 16,
    localY: packedPosition % 16,
    stateId: (numeric - packedPosition) / 4096,
  };
}

/**
 * Both wire encodings of `multi_block_change`, because they disagree completely:
 *   - 1.8–1.15 sent one container per record (`horizontalPos`, absolute `y`,
 *     `blockId`) alongside flat `chunkX` / `chunkZ`.
 *   - 1.16+ sends a section-relative packed `varlong`/`varint` per record with a
 *     `chunkCoordinates` bitfield carrying the section Y.
 * Reading the container field names off a packed number yields `undefined` for
 * every field, which dropped every batched update without a trace — the class of
 * silent failure this repo keeps having to dig back out.
 */
export function parseMultiBlockChangePackets(packet: unknown): AuthoritativeBlockUpdate[] {
  const record = asRecord(packet);
  const records = Array.isArray(record?.records) ? record.records : [];
  const chunkCoordinates = asRecord(record?.chunkCoordinates);
  const chunkX = finiteNumber(chunkCoordinates?.x ?? record?.chunkX);
  const sectionY = finiteNumber(chunkCoordinates?.y);
  const chunkZ = finiteNumber(chunkCoordinates?.z ?? record?.chunkZ);
  if (chunkX === null || chunkZ === null) return [];

  const updates: AuthoritativeBlockUpdate[] = [];
  for (const entry of records) {
    const change = asRecord(entry);
    if (change) {
      const horizontalPos = finiteNumber(change.horizontalPos);
      const absoluteY = finiteNumber(change.y);
      const stateId = finiteNumber(change.blockId);
      if (horizontalPos === null || absoluteY === null || stateId === null) {
        continue;
      }
      updates.push({
        position: {
          x: chunkX * 16 + (Math.floor(horizontalPos / 16) % 16),
          y: absoluteY,
          z: chunkZ * 16 + (horizontalPos % 16),
        },
        stateId,
      });
      continue;
    }
    const packed = packedSectionRecord(entry);
    if (!packed) continue;
    updates.push({
      position: {
        x: chunkX * 16 + packed.localX,
        y: (sectionY ?? 0) * 16 + packed.localY,
        z: chunkZ * 16 + packed.localZ,
      },
      stateId: packed.stateId,
    });
  }
  return updates;
}

/**
 * `acknowledge_player_digging` also has two shapes. 1.19+ carries only a
 * `sequenceId`, which Mineflayer always writes as 0, so it cannot be matched to
 * a specific dig — it is attributable only by the window it arrives in. 1.16–1.18
 * name the block and say outright whether the action succeeded. Versions before
 * 1.16 have no such packet, so there the confirmation falls back to block
 * updates alone.
 */
export type DiggingAck =
  | Readonly<{ kind: "sequence" }>
  | Readonly<{
      kind: "positional";
      position: BlockPosition;
      status: number;
      successful: boolean;
    }>;

export function parseDiggingAckPacket(packet: unknown): DiggingAck | null {
  const record = asRecord(packet);
  if (!record) return null;
  const location = asRecord(record.location);
  if (location) {
    const x = finiteNumber(location.x);
    const y = finiteNumber(location.y);
    const z = finiteNumber(location.z);
    const status = finiteNumber(record.status);
    if (x === null || y === null || z === null || status === null) return null;
    return {
      kind: "positional",
      position: { x, y, z },
      status,
      successful: record.successful === true,
    };
  }
  return finiteNumber(record.sequenceId) === null ? null : { kind: "sequence" };
}
