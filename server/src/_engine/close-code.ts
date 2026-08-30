/** True when a number is permitted in a server-sent WebSocket close frame. */
export function isValidCloseCode(code: unknown): code is number {
  return (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  );
}
