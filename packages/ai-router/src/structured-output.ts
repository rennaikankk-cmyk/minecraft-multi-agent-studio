import { AIError } from "./errors.js";
import type { AIOutputContract } from "./request.js";

function stripMarkdownFence(content: string): string | null {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu.exec(content);
  return match?.[1] ?? null;
}

function extractBalancedJson(content: string): string | null {
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (start < 0) {
      if (character !== "{" && character !== "[") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth === 0) return content.slice(start, index + 1);
  }
  return null;
}

export function parseStructuredOutput<T>(
  content: string,
  contract: AIOutputContract<T>,
): T {
  const trimmed = content.trim();
  const candidates = [trimmed, stripMarkdownFence(trimmed), extractBalancedJson(trimmed)]
    .filter((candidate): candidate is string => candidate !== null);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsedJson: unknown = JSON.parse(candidate);
      const parsed = contract.schema.safeParse(parsedJson);
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next conservative extraction candidate. Model text is never evaluated.
    }
  }
  throw new AIError(
    "AI_OUTPUT_INVALID",
    `AI output did not satisfy structured contract ${contract.name}.`,
    { retryable: true },
  );
}
