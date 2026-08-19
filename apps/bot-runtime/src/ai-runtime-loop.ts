import type { BotClient } from "./client.js";
import type { SkillExecutor } from "@minecraft-studio/skills";

export type AILoopConfig = {
  enabled: boolean;
  apiUrl: string;
  model: string;
  intervalMs?: number;
  systemPrompt?: string;
};

export class AIRuntimeLoop {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly config: AILoopConfig,
    private readonly skillExecutor: SkillExecutor,
    private readonly getClient: () => BotClient | null,
  ) {
    this.intervalMs = config.intervalMs ?? 5000; // 默认 5 秒
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const client = this.getClient();
    if (!client) return;

    try {
      // 1. 收集当前状态
      const snapshot = client.snapshot();
      const context = this.buildContext(snapshot);

      // 2. 调用本地 AI 决策
      const decision = await this.callLocalAI(context);

      // 3. 执行技能
      if (decision?.skillId) {
        await this.executeSkill(decision);
      }
    } catch (error) {
      console.error("[AIRuntimeLoop] Tick error:", error);
    }
  }

  private buildContext(snapshot: any): string {
    return JSON.stringify({
      health: snapshot.health,
      food: snapshot.food,
      position: snapshot.position,
      inventory: snapshot.inventory?.items?.slice(0, 10), // 只取前 10 项
      nearbyEntities: snapshot.nearbyEntities?.slice(0, 5),
    });
  }

  private async callLocalAI(context: string): Promise<any> {
    const response = await fetch(`${this.config.apiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content: this.config.systemPrompt ?? "You are a Minecraft bot. Decide what to do based on the current state.",
          },
          { role: "user", content: `Current state: ${context}` },
        ],
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    // 简单解析 AI 返回的 JSON 决策
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async executeSkill(decision: any): Promise<void> {
    // TODO: 调用 skillExecutor.execute
    console.log("[AIRuntimeLoop] Would execute skill:", decision);
  }
}
