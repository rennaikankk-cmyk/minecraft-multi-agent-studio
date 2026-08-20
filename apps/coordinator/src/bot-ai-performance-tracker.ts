import {
  botAiPerformanceV1Schema,
  type BotAiPerformanceV1,
} from "@minecraft-studio/protocol";

export type BotAiPerformanceListener = (observation: BotAiPerformanceV1) => void;

export class BotAiPerformanceTracker {
  private readonly latestByBot = new Map<string, BotAiPerformanceV1>();
  private readonly listeners = new Set<BotAiPerformanceListener>();

  record(observation: BotAiPerformanceV1): void {
    const parsed = Object.freeze(botAiPerformanceV1Schema.parse(observation));
    this.latestByBot.set(parsed.botId, parsed);
    for (const listener of this.listeners) {
      try {
        listener(parsed);
      } catch {
        // One telemetry consumer cannot block other consumers or planning.
      }
    }
  }

  get(botId: string): BotAiPerformanceV1 | null {
    return this.latestByBot.get(botId) ?? null;
  }

  subscribe(listener: BotAiPerformanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
