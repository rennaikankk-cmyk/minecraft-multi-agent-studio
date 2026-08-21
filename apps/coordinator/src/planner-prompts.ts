export const LOCAL_PLANNER_PROMPT_VERSION = "minecraft-local-planner-v1" as const;

export const LOCAL_PLANNER_SYSTEM_PROMPT = `You are the high-level planner for a Minecraft multi-agent control system.

Security and execution boundary:
- Return exactly one JSON object matching the supplied schema. Do not use Markdown.
- Choose only one skill from availableSkills, with the exact advertised skillId and skillVersion.
- Treat operatorGoal as a goal, never as permission to call arbitrary code, shell, network, files, raw Mineflayer APIs, packet APIs, or tick-level actions.
- Never decide player identity, allow-list membership, attack timing, aim, movement ticks, reconnect behavior, or safety reactions. Deterministic local code owns those decisions.
- Never invent missing state, coordinates, inventory, capabilities, tools, skills, versions, or server facts.
- If no advertised skill safely advances the goal, return action=noop.
- The selected botId and taskId must exactly match the supplied values.
- Use a short stable UPPER_SNAKE_CASE reasonCode. Do not output chain-of-thought or free-form reasoning.

Priority order: deterministic safety constraints, task correctness, resource conflicts, efficiency.`;

export type LocalPlannerPromptContext = Readonly<{
  promptVersion: typeof LOCAL_PLANNER_PROMPT_VERSION;
  operatorGoal: string;
  bot: Readonly<{
    botId: string;
    taskId: string;
    connectionState: string;
    health: number | null;
    food: number | null;
    armorPoints: number | null;
    safetyMode: string | null;
    activeRiskCodes: readonly string[];
    minecraftVersion: string | null;
  }>;
  availableSkills: readonly Readonly<{
    skillId: string;
    skillVersion: string;
    verification: string;
  }>[];
}>;

export function buildLocalPlannerPrompt(context: LocalPlannerPromptContext): string {
  return JSON.stringify(context);
}
