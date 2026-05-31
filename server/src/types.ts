/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * A validator for an incoming message payload — any Standard Schema (valibot,
 * zod, arktype, or any other compliant library).
 *
 * Accepted everywhere WSKit expects validation: `incoming`, `request`,
 * `stream`, `nudge`, `check`. TypeScript infers the payload type
 * from the schema, so your handler is typed automatically.
 *
 * ```ts
 * import * as v from 'valibot';
 *
 * incoming('send-message', v.object({ text: v.string() }));
 * request('get-user', {
 *   payload: v.object({ id: v.string() }),
 *   response: v.object({ name: v.string() }),
 * });
 * ```
 */
export type Validator<T = any> = StandardSchemaV1<unknown, T>;
