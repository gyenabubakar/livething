/**
 * Build the routing key for a channel. Scope-qualified so two channels that
 * share a name in different families never clash. Uses the same `[scope, name]`
 * JSON shape the server keys memberships by, so the two stay in step.
 */
export function channelKey(scope: string | null | undefined, name: string): string {
  return JSON.stringify([scope ?? null, name]);
}
