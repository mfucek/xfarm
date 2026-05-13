// Backwards-compatible re-export. The real implementation lives in src/judge/.
export {
  Judge,
  judgeLoop,
  makeLlmClient,
  resolveCredentialsPath,
} from "./judge/index.ts";
export type { LlmClient } from "./judge/index.ts";
