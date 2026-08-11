import {
  BotRegistry,
  type BotRegistryRecord,
} from "@minecraft-studio/coordinator";
import type {
  BotStopResultV1,
  PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import type { StopBotRequest } from "@minecraft-studio/coordinator";

import { toPublicBotDetail } from "./public-view.js";

const FULL_READ_PERMISSIONS = new Set([
  "bot.read",
  "bot.position.read",
] as const);

export type BotStateListener = (bot: PublicBotDetailV1) => void;
export type BotStateAvailabilityListener = (ready: boolean) => void;

export type BotStateSource = Readonly<{
  isReady(): boolean;
  get(botId: string, at: Date): PublicBotDetailV1 | null;
  list(at: Date): PublicBotDetailV1[];
  subscribe(listener: BotStateListener): () => void;
  subscribeAvailability(listener: BotStateAvailabilityListener): () => void;
  sweepStale?(at: Date): number;
}>;

export type BotStopRequester = Readonly<{
  requestStop(request: StopBotRequest): Promise<BotStopResultV1>;
}>;

/**
 * Adapts the authoritative in-process registry for focused tests and library
 * users. Production Control API uses the authenticated Coordinator mirror.
 */
export class RegistryBotStateSource implements BotStateSource {
  constructor(private readonly registry: BotRegistry) {}

  isReady(): boolean {
    return true;
  }

  get(botId: string, at: Date): PublicBotDetailV1 | null {
    const record = this.registry.get(botId, at);
    return record ? projectRecord(record) : null;
  }

  list(at: Date): PublicBotDetailV1[] {
    return this.registry.list(at).map(projectRecord);
  }

  subscribe(listener: BotStateListener): () => void {
    return this.registry.subscribe((record) => listener(projectRecord(record)));
  }

  subscribeAvailability(_listener: BotStateAvailabilityListener): () => void {
    return () => undefined;
  }

  sweepStale(at: Date): number {
    return this.registry.sweepStale(at);
  }
}

export function normalizeBotStateSource(
  source: BotStateSource | BotRegistry,
): BotStateSource {
  return source instanceof BotRegistry
    ? new RegistryBotStateSource(source)
    : source;
}

function projectRecord(record: BotRegistryRecord): PublicBotDetailV1 {
  return toPublicBotDetail(record, FULL_READ_PERMISSIONS);
}
