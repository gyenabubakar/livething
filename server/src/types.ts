/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * A validator for an incoming message payload — any Standard Schema (valibot,
 * zod, arktype, or any other compliant library).
 *
 * Accepted everywhere wskit expects validation: `incoming`, `request`,
 * `stream`, `nudge`, `onBeforeSubscribe`. TypeScript infers the payload type
 * from the schema, so your handler is typed automatically.
 *
 * ```ts
 * import * as v from 'valibot';
 *
 * incoming(
 *   'send-message',
 *   (ctx, payload) => { /* payload is { text: string } *\/ },
 *   { validator: v.object({ text: v.string() }) },
 * );
 * ```
 */
export type Validator<T = any> = StandardSchemaV1<unknown, T>;
