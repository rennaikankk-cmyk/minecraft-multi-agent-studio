import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  botPersonalMemoryScopeSchema, botPersonalMemoryV1Schema, botStatusV1Schema,
  type BotPersonalMemoryScope, type BotPersonalMemoryV1, type BotStatusV1,
} from "@minecraft-studio/protocol";

export interface PersonalMemoryStore {
  readonly durability: "file";
  get(scope: BotPersonalMemoryScope): BotPersonalMemoryV1 | null;
  observeStatus(message: BotStatusV1): void;
  /** Latest observation for a bot on one server across every world generation. */
  getLatestForBot?(botId: string, serverProfileId: string): BotPersonalMemoryV1 | null;
}

export class PersonalMemoryError extends Error {
  constructor(readonly code: "PERSONAL_MEMORY_READ_FAILED" | "PERSONAL_MEMORY_WRITE_FAILED") {
    // File paths and coordinates must never reach runtime-link logs.
    super(code);
    this.name = "PersonalMemoryError";
  }
}

/** Single Coordinator writer, using its existing desktop file durability boundary. */
export class FilePersonalMemoryStore implements PersonalMemoryStore {
  readonly durability = "file" as const;
  constructor(private readonly dir: string) {}

  get(input: BotPersonalMemoryScope): BotPersonalMemoryV1 | null {
    const scope = botPersonalMemoryScopeSchema.parse(input);
    try {
      const parsed = botPersonalMemoryV1Schema.parse(JSON.parse(readFileSync(this.filename(scope), "utf8")));
      if (scopeKey(parsed.scope) !== scopeKey(scope)) throw new Error("scope_mismatch");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new PersonalMemoryError("PERSONAL_MEMORY_READ_FAILED");
    }
  }

  /**
   * Filenames are scope hashes, so bot lookup scans the directory. The file
   * population is one file per (bot, server, world) scope, which is bounded
   * by the bot fleet size. Unreadable or corrupt files are skipped rather
   * than failing the lookup: memory is an enhancement, never a precondition.
   */
  getLatestForBot(botId: string, serverProfileId: string): BotPersonalMemoryV1 | null {
    let entries: readonly string[];
    try {
      entries = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new PersonalMemoryError("PERSONAL_MEMORY_READ_FAILED");
    }
    let latest: BotPersonalMemoryV1 | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = botPersonalMemoryV1Schema.parse(JSON.parse(readFileSync(path.join(this.dir, entry), "utf8")));
        if (parsed.scope.botId !== botId || parsed.scope.serverProfileId !== serverProfileId) continue;
        if (latest === null || Date.parse(parsed.lastObservedAt) > Date.parse(latest.lastObservedAt)) latest = parsed;
      } catch {
        continue;
      }
    }
    return latest;
  }

  observeStatus(input: BotStatusV1): void {
    const message = botStatusV1Schema.parse(input);
    const value = message.payload;
    // Only game observations count; connection placeholders must not erase memory.
    if (value.connectionState !== "online") return;
    const scope = { botId: message.botId, serverProfileId: value.serverProfileId,
      worldId: value.personalContext?.worldId ?? null };
    const previous = this.get(scope);
    if (previous && (Date.parse(value.observedAt) < Date.parse(previous.lastObservedAt) ||
      (value.runtimeInstanceId !== previous.runtimeInstanceId && Date.parse(value.observedAt) === Date.parse(previous.lastObservedAt)) ||
      (value.runtimeInstanceId === previous.runtimeInstanceId && value.sequence <= previous.sequence))) return;
    const observed = <T>(fact: T) => ({ observedAt: value.observedAt, runtimeInstanceId: value.runtimeInstanceId, value: fact });
    const memory = botPersonalMemoryV1Schema.parse({
      schemaVersion: "1.0", scope, lastObservedAt: value.observedAt,
      runtimeInstanceId: value.runtimeInstanceId, sequence: value.sequence,
      position: observed(value.position),
      // Absent and empty are distinct: a real empty inventory overwrites history.
      inventory: value.inventory === undefined ? previous?.inventory ?? null : observed(value.inventory),
      equipment: observed({ armorPoints: value.armorPoints, armorSlots: value.armorSlots ?? null }),
      lastDeath: value.lastDeath ? observed(value.lastDeath) : previous?.lastDeath ?? null,
      // A server spawn packet is a compass/world spawn observation, never a bed.
      // Retained confirmations remain historical with their original timestamps.
      worldSpawn: value.personalContext?.worldSpawn ?? previous?.worldSpawn ?? null,
      verifiedRespawn: value.personalContext?.verifiedRespawn ?? previous?.verifiedRespawn ?? null,
    });
    this.save(memory);
  }

  private filename(scope: BotPersonalMemoryScope): string {
    return path.join(this.dir, `${createHash("sha256").update(scopeKey(scope)).digest("hex")}.json`);
  }

  private save(memory: BotPersonalMemoryV1): void {
    const target = this.filename(memory.scope);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(memory));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, target);
      if (process.platform !== "win32") {
        descriptor = openSync(this.dir, "r");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
      }
    } catch {
      throw new PersonalMemoryError("PERSONAL_MEMORY_WRITE_FAILED");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* Only our own temporary file. */ }
    }
  }
}

function scopeKey(scope: BotPersonalMemoryScope): string {
  return JSON.stringify([scope.serverProfileId, scope.worldId, scope.botId]);
}
