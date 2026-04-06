/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * A validator for incoming payloads. Accepted everywhere wskit expects
 * validation — `incoming`, `request`, `stream`, `nudge`, `onBeforeSubscribe`.
 *
 * Two forms:
 *
 * 1. **StandardSchema** — any compliant library (valibot, zod, arktype):
 *    ```ts
 *    { validator: v.object({ text: v.string() }) }
 *    ```
 *
 * 2. **Parse function** — returns the parsed value or throws:
 *    ```ts
 *    { validator: (p) => {
 *      const obj = p as Record<string, unknown>;
 *      if (typeof obj.text !== 'string') throw new Error('text required');
 *      return { text: obj.text };
 *    }}
 *    ```
 *
 * TypeScript infers the payload type from either form.
 */
export type Validator<T = any> = StandardSchemaV1<unknown, T> | ((value: unknown) => T);
