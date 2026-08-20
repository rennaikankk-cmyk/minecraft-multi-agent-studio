import { WorldMemoryError } from "./errors.js";
import {
  MAX_WORLD_MEMORY_QUERY_RESULTS,
  worldMemoryPositionSchema,
  type WorldMemoryKind,
  type WorldMemoryPosition,
  type WorldMemoryRecord,
  type WorldMemorySearchResult,
} from "./model.js";
import type { WorldMemoryRepositoryLike } from "./repository.js";

const MODEL_SAFE_KINDS = Object.freeze([
  "hazard",
  "landmark",
  "portal",
  "resource",
  "route",
] as const satisfies readonly WorldMemoryKind[]);

export type WorldMemoryPlannerContextRequest = Readonly<{
  serverProfileId: string;
  dimension: string;
  position: WorldMemoryPosition;
  subjectId: string;
  task: string;
  signal?: AbortSignal;
}>;

export interface WorldMemoryEmbeddingProvider {
  readonly model: string;
  embed(
    text: string,
    signal?: AbortSignal,
  ): Promise<readonly number[]>;
}

export type WorldMemoryRerankCandidate = Readonly<{
  memoryId: string;
  kind: WorldMemoryKind;
  summary: string;
  confidence: number;
  cosineDistance: number | null;
  distance: number | null;
}>;

export interface WorldMemoryReranker {
  rerank(
    task: string,
    candidates: readonly WorldMemoryRerankCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
}

export type WorldMemoryPlannerContextOptions = Readonly<{
  maxEntries?: number;
  candidateMultiplier?: number;
  radius?: number;
  minimumConfidence?: number;
  embeddingProvider?: WorldMemoryEmbeddingProvider;
  reranker?: WorldMemoryReranker;
}>;

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedNumber(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorldMemoryError(
      "WORLD_MEMORY_LOOKUP_CANCELLED",
      "World-memory lookup was cancelled.",
    );
  }
}

function rerankCandidates(
  results: readonly WorldMemorySearchResult[],
): readonly WorldMemoryRerankCandidate[] {
  return results.map(({ memory, cosineDistance, distance }) =>
    Object.freeze({
      memoryId: memory.memoryId,
      kind: memory.kind,
      summary: memory.summary,
      confidence: memory.confidence,
      cosineDistance,
      distance,
    }),
  );
}

function safeForModel(
  memory: WorldMemoryRecord,
  request: WorldMemoryPlannerContextRequest,
): boolean {
  return (
    memory.serverProfileId === request.serverProfileId &&
    memory.dimension === request.dimension &&
    memory.visibility === "team" &&
    memory.modelAccess &&
    MODEL_SAFE_KINDS.includes(memory.kind as (typeof MODEL_SAFE_KINDS)[number])
  );
}

function formatForModel(memory: WorldMemoryRecord): string {
  return `[${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.summary}`;
}

export class WorldMemoryPlannerContextService {
  private readonly maxEntries: number;
  private readonly candidateMultiplier: number;
  private readonly radius: number;
  private readonly minimumConfidence: number;

  constructor(
    private readonly repository: WorldMemoryRepositoryLike,
    private readonly options: WorldMemoryPlannerContextOptions = {},
  ) {
    this.maxEntries = boundedInteger(options.maxEntries ?? 12, 1, 32, "maxEntries");
    this.candidateMultiplier = boundedInteger(
      options.candidateMultiplier ?? 3,
      1,
      4,
      "candidateMultiplier",
    );
    this.radius = boundedNumber(options.radius ?? 4_096, 1, 60_000_000, "radius");
    this.minimumConfidence = boundedNumber(
      options.minimumConfidence ?? 0.2,
      0,
      1,
      "minimumConfidence",
    );
  }

  async retrieve(
    input: WorldMemoryPlannerContextRequest,
  ): Promise<readonly string[]> {
    const request = {
      ...input,
      position: worldMemoryPositionSchema.parse(input.position),
    };
    if (request.task.trim().length < 1 || request.task.length > 10_000) {
      throw new TypeError("Memory retrieval task must contain between 1 and 10000 characters.");
    }
    assertNotCancelled(request.signal);
    try {
      const embedding = this.options.embeddingProvider
        ? await this.options.embeddingProvider.embed(
            request.task,
            request.signal,
          )
        : null;
      assertNotCancelled(request.signal);
      const results = await this.repository.search({
        serverProfileId: request.serverProfileId,
        dimension: request.dimension,
        subjectId: request.subjectId,
        kinds: [...MODEL_SAFE_KINDS],
        tags: [],
        minimumConfidence: this.minimumConfidence,
        observedAfter: null,
        center: { ...request.position, radius: this.radius },
        semantic:
          embedding === null
            ? null
            : {
                model: this.options.embeddingProvider!.model,
                values: [...embedding],
              },
        modelAccessOnly: true,
        limit: Math.min(
          MAX_WORLD_MEMORY_QUERY_RESULTS,
          this.maxEntries * this.candidateMultiplier,
        ),
      });
      assertNotCancelled(request.signal);

      const safeResults = results.filter(({ memory }) =>
        safeForModel(memory, request),
      );
      let ordered = safeResults;
      if (this.options.reranker && safeResults.length > 1) {
        const rankedIds = await this.options.reranker.rerank(
          request.task,
          rerankCandidates(safeResults),
          request.signal,
        );
        assertNotCancelled(request.signal);
        const byId = new Map(
          safeResults.map((result) => [result.memory.memoryId, result]),
        );
        const seen = new Set<string>();
        ordered = rankedIds.map((memoryId) => {
          if (seen.has(memoryId) || !byId.has(memoryId)) {
            throw new WorldMemoryError(
              "WORLD_MEMORY_LOOKUP_FAILED",
              "Memory reranker returned a duplicate or unauthorized record.",
            );
          }
          seen.add(memoryId);
          return byId.get(memoryId)!;
        });
      }

      return Object.freeze(
        ordered
          .slice(0, this.maxEntries)
          .map(({ memory }) => formatForModel(memory)),
      );
    } catch (error) {
      if (error instanceof WorldMemoryError) throw error;
      throw new WorldMemoryError(
        "WORLD_MEMORY_LOOKUP_FAILED",
        "World-memory lookup failed closed.",
        { cause: error },
      );
    }
  }
}
