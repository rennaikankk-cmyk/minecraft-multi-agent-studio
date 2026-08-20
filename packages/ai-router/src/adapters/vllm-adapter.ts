import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from "../providers/openai-compatible-provider.js";

/** vLLM is OpenAI-compatible; this class name remains for migration compatibility. */
export class VLLMAdapter extends OpenAICompatibleProvider {
  constructor(baseUrl: string, model: string, apiKey?: string) {
    const config: OpenAICompatibleProviderConfig = {
      name: "spark-vllm",
      baseUrl,
      model,
      kind: "local",
      ...(apiKey === undefined ? {} : { apiKey }),
    };
    super(config);
  }
}
