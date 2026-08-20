export type WorldMemoryErrorCode =
  | "WORLD_MEMORY_IDEMPOTENCY_CONFLICT"
  | "WORLD_MEMORY_INGESTION_FAILED"
  | "WORLD_MEMORY_LOOKUP_CANCELLED"
  | "WORLD_MEMORY_LOOKUP_FAILED"
  | "WORLD_MEMORY_NOT_FOUND"
  | "WORLD_MEMORY_OUTBOX_CONFLICT"
  | "WORLD_MEMORY_OUTBOX_FULL"
  | "WORLD_MEMORY_OUTBOX_INVALID"
  | "WORLD_MEMORY_OUTBOX_IO_FAILED"
  | "WORLD_MEMORY_SCHEMA_UNAVAILABLE"
  | "WORLD_MEMORY_SOURCE_INVALID";

export class WorldMemoryError extends Error {
  constructor(
    readonly code: WorldMemoryErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorldMemoryError";
  }
}
