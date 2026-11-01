// Huddle's audit log: yields each new line until `signal` aborts.
export declare function auditLogEntries(
  signal: AbortSignal,
): AsyncIterable<{ line: string; level: 'info' | 'warn' | 'error' }>;
