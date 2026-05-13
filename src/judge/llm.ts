// Provider-agnostic LLM client used by Judge and Suggester. Both want the
// same shape: render a prompt template, ask the model for strict JSON,
// parse the response.

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

export interface LlmClient {
  /**
   * Send `prompt` to the model and return its JSON response, parsed and
   * validated as best we can. The schema is advisory for providers that
   * support structured output; for providers that don't, the implementation
   * appends the schema to the prompt and falls back to JSON.parse.
   */
  generateJson<T = unknown>(prompt: string, schema: JsonSchema): Promise<T>;
}
