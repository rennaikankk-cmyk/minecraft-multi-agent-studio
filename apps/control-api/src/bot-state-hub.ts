import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";

import type { BotStateSource } from "./bot-state-source.js";

export type BotStateEvent = Readonly<{
  streamSequence: number;
  bot: PublicBotDetailV1;
}>;

export type BotStateSubscription = Readonly<{
  streamSequence: number;
  bots: PublicBotDetailV1[];
  unsubscribe: () => void;
}>;

export class BotStateHub {
  private streamSequence = 0;
  private readonly listeners = new Set<(event: BotStateEvent) => void>();
  private readonly unsubscribeRegistry: () => void;

  constructor(private readonly source: BotStateSource) {
    this.unsubscribeRegistry = source.subscribe((bot) => {
      this.streamSequence += 1;
      const event = { streamSequence: this.streamSequence, bot };
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
    let bots: PublicBotDetailV1[];
    try {
      bots = this.source.list(at);
    } catch (cause) {
      this.listeners.delete(listener);
      throw cause;
    }
    return {
      streamSequence: this.streamSequence,
      bots,
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  dispose(): void {
    this.unsubscribeRegistry();
    this.listeners.clear();
  }
}
