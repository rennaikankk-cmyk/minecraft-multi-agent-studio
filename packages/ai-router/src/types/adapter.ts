/** Compatibility exports for the initial scaffold. New code uses AIProvider. */
export type {
  AIProvider as AIAdapter,
  AIProviderHealth as HealthResult,
  AIProviderResponse as GenerateResult,
} from "./provider.js";
export type { AIRequest as GenerateOptions } from "../request.js";
