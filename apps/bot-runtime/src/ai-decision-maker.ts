import { AIRouter } from '@minecraft-studio/ai-router';
import type { BotClientSnapshot } from './client.js';

export interface DecisionContext {
  snapshot: BotClientSnapshot;
  nearbyEntities: string[];
  inventory: string[];
  health: number;
  position: { x: number; y: number; z: number };
}

export interface AIDecision {
  skill: string;
  params: Record<string, unknown>;
  reasoning: string;
}

export class AIDecisionMaker {
  constructor(
    private readonly router: AIRouter,
    private readonly model: string = 'huihui-qwen'
  ) {}

  async decide(context: DecisionContext): Promise<AIDecision | null> {
    const prompt = this.buildPrompt(context);
    
    try {
      const result = await this.router.generate({
        prompt,
        systemPrompt: this.getSystemPrompt(),
        maxTokens: 300,
        temperature: 0.7,
        timeoutMs: 15000,
        traceId: `decision-${Date.now()}`
      });

      return this.parseDecision(result.content);
    } catch (error) {
      console.error('AI decision failed:', error);
      return null;
    }
  }

  private buildPrompt(ctx: DecisionContext): string {
    return `
Current situation:
- Position: x=${ctx.position.x.toFixed(1)}, y=${ctx.position.y.toFixed(1)}, z=${ctx.position.z.toFixed(1)}
- Health: ${ctx.health}/20
- Nearby entities: ${ctx.nearbyEntities.join(', ') || 'none'}
- Inventory: ${ctx.inventory.slice(0, 5).join(', ')}

Available skills: goto, collect_block, craft_item, place_block, equip_armor, container_transfer, smelt_item

Decide ONE action. Response format:
{
  "skill": "skill_name",
  "params": {...},
  "reasoning": "why"
}
`.trim();
  }

  private getSystemPrompt(): string {
    return `You are a Minecraft survival bot AI. Analyze the situation and choose ONE skill to execute.
Response MUST be valid JSON matching the format shown.
Prioritize: survival > resources > exploration.`;
  }

  private parseDecision(content: string): AIDecision | null {
    try {
      // 提取 JSON (处理可能的思考链)
      const jsonMatch = content.match(/\{[\s\S]*"skill"[\s\S]*\}/);
      if (!jsonMatch) return null;
      
      const decision = JSON.parse(jsonMatch[0]);
      if (!decision.skill || !decision.params) return null;
      
      return decision as AIDecision;
    } catch {
      return null;
    }
  }
}
