/**
 * Maps the in-code `null` family (a static channel) to the empty string on disk,
 * so the `(user_id, channel_name, channel_family)` primary keys stay well-formed
 * — SQLite treats NULLs as distinct in a PK. Mirrors the persistence layer.
 */
export function familyToDb(family: string | null): string {
  return family ?? '';
}

/** Maps a stored empty family back to the in-code `null`. */
export function familyFromDb(family: string): string | null {
  return family === '' ? null : family;
}
