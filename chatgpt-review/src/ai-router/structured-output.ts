import type { z } from "zod";

import { AIError } from "./errors.js";

/**
 * A named output contract. `name` appears in the thrown error so a failure can
 * be attributed to a specific call site without logging model text.
 */
export type AIOutputContract<T> = Readonly<{
  name: string;
  schema: z.ZodType<T>;
}>;

/**
 * Recovers a JSON object from model text that may carry a markdown fence or
 * surrounding prose, then validates it against `contract.schema`.
 *
 * Recovery is lexical only — candidates are produced by slicing the input and
 * handed to `JSON.parse`. Model text is never evaluated, and a candidate that
 * parses but fails the schema is discarded rather than partially accepted.
 *
 * This does not replace strict schema enforcement at the provider. Ollama's
 * native `format` already constrains generation; this is the second line of
 * defence for the residual cases that constraint does not cover (a fence
 * emitted around otherwise-valid JSON, or a model that ignores the grammar).
 */
export function parseStructuredOutput<T>(
  content: string,
  contract: AIOutputContract<T>,
): T {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    stripMarkdownFence(trimmed),
    extractBalancedJson(trimmed),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of new Set(candidates)) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = contract.schema.safeParse(parsedJson);
    if (parsed.success) return parsed.data;
  }

  throw new AIError(
    "AI_OUTPUT_INVALID",
    `AI output did not satisfy structured contract ${contract.name}.`,
    { retryable: true },
  );
}

function stripMarkdownFence(content: string): string | null {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(content);
  return match?.[1] ?? null;
}

/**
 * Returns the first balanced JSON object or array in `content`, tracking string
 * state so that braces and brackets inside string literals do not affect depth.
 */
function extractBalancedJson(content: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;

    if (start < 0) {
      if (character !== "{" && character !== "[") continue;
      start = index;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }

  return null;
}
