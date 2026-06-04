// The handlers are platform-agnostic: they only use `Env` as a contract type
// marker, never reading its fields. Each adapter (cloudflare/, etc.) supplies
// the real binding shape; here an empty global keeps the handlers typechecking
// on their own.
declare global {
  interface Env {}
}

export {};
