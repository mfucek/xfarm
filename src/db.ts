// Re-export shim. The DB class was split into per-entity modules under
// ./db/. Existing `import { DB } from "./db.ts"` call sites resolve here.
export { DB } from "./db/index.ts";
