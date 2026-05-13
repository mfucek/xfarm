// Provider-agnostic LLM client used by Judge and Suggester. Both want the
// same shape: render a prompt template, ask the model for strict JSON,
// parse the response. The optional agentic variant lets the model call
// out to one or more tools (e.g. an MCP tool) before producing the JSON.

export type JsonSchema =
  | { type: "string"; enum?: string[] }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "array"; items: JsonSchema }
  | {
      type: "object";
      required?: string[];
      properties: Record<string, JsonSchema>;
    };

export type Tool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

export interface LlmClient {
  /**
   * Send `prompt` to the model and return its JSON response, parsed and
   * validated as best we can. The schema is advisory for providers that
   * support structured output; for providers that don't, the implementation
   * appends the schema to the prompt and falls back to JSON.parse.
   */
  generateJson<T = unknown>(prompt: string, schema: JsonSchema): Promise<T>;

  /**
   * Same contract as `generateJson` but the model may call `tools` 0..N times
   * before producing the final JSON. Implementations bound iterations and
   * surface tool failures back to the model so it can adapt. Optional —
   * providers that can't support function calling simply omit this method
   * and callers fall back to the single-shot path.
   */
  generateJsonAgentic?<T = unknown>(
    prompt: string,
    schema: JsonSchema,
    tools: Tool[],
    maxIterations?: number,
  ): Promise<T>;
}
