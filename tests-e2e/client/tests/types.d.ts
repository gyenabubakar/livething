/// <reference types="vite/client" />

// The handler contracts we import for typing reference an ambient `Env` (their
// upgrade env binding). The client never reads it — an empty ambient
// declaration is enough for the inferred contract types to resolve here.
declare global {
  interface Env {}
}

export {};
