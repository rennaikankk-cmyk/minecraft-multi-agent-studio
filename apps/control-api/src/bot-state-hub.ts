import type {
  BotRegistry,
  BotRegistryRecord,
} from "@minecraft-studio/coordinator";

export type BotStateEvent = Readonly<{
  streamSequence: number;
  record: BotRegistryRecord;
}>;

export type BotStateSubscription = Readonly<{
  streamSequence: number;
  records: BotRegistryRecord[];
  unsubscribe: () => void;
}>;

export class BotStateHub {
  private streamSequence = 0;
  private readonly listeners = new Set<(event: BotStateEvent) => void>();
  private readonly unsubscribeRegistry: () => void;

  constructor(private readonly registry: BotRegistry) {
    this.unsubscribeRegistry = registry.subscribe((record) => {
      this.streamSequence += 1;
      const event = { streamSequence: this.streamSequence, record };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // One client cannot interrupt registry-to-stream fanout.
        }
      }
    });
  }

  subscribe(
    listener: (event: BotStateEvent) => void,
    at: Date,
  ): BotStateSubscription {
    this.listeners.add(listener);
    const records = this.registry.list(at);
    return {
      streamSequence: this.streamSequence,
      records,
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  dispose(): void {
    this.unsubscribeRegistry();
    this.listeners.clear();
  }
}
