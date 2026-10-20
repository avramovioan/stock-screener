// Pure domain core shared by Deno Edge Functions, the Vite app and Vitest.
// Rules: relative ".ts" imports only, no Deno/Node/DOM globals, no Date.now(), no Math.random().
export const CORE_VERSION = "0.0.1";
export * from "./digest.ts";
