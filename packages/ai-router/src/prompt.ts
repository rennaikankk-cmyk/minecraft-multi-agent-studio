import type { CompactBotContext } from "./compact-context.js";

export type PrefixCachePromptInput = Readonly<{
  systemPrompt: string;
  minecraftRules: string;
  skillCatalog: string;
  outputSchema: string;
  context: CompactBotContext;
  task: string;
}>;

/** Stable sections are intentionally first so compatible inference backends can reuse prefixes. */
export function buildPrefixCachePrompt(input: PrefixCachePromptInput): Readonly<{
  systemPrompt: string;
  prompt: string;
}> {
  return Object.freeze({
    systemPrompt: [
      input.systemPrompt,
      "<minecraft_rules>",
      input.minecraftRules,
      "</minecraft_rules>",
      "<skill_catalog>",
      input.skillCatalog,
      "</skill_catalog>",
      "<output_schema>",
      input.outputSchema,
      "</output_schema>",
    ].join("\n"),
    prompt: [
      "<compact_bot_context>",
      JSON.stringify(input.context),
      "</compact_bot_context>",
      "<current_task>",
      input.task,
      "</current_task>",
    ].join("\n"),
  });
}
