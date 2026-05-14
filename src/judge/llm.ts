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
  /** Short progress label shown in the TUI while this tool is running, e.g.
   * "Asking Naumu…". Falls back to a generic label when omitted. */
  progressLabel?: string;
};

/** Stream of progress states emitted while the agentic loop runs. The TUI
 * uses these to render "judging… <status>" — the daemon ignores them. */
export type StatusCallback = (status: string) => void;

export type AgenticOptions = {
  maxIterations?: number;
  onStatus?: StatusCallback;
  /** Prefix prepended to every log line emitted from inside the agentic
   * loop (e.g. "tweet=1a2b3c…"). Lets one log file correlate lines back to
   * the tweet that triggered them. */
  logPrefix?: string;
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
    opts?: AgenticOptions,
  ): Promise<T>;
}
