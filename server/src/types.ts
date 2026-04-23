/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * A validator for an incoming message payload.
 *
 * Accepted everywhere wskit expects validation — `incoming`, `request`,
 * `stream`, `nudge`, `onBeforeSubscribe`.
 *
 * TypeScript infers the payload type from whichever form you use, so your
 * handler will be automatically typed.
 *
 * **Form 1 — StandardSchema** (any compliant library: valibot, zod, arktype):
 * ```ts
 * import * as v from 'valibot';
 *
 * incoming(
 *   'send-message',
 *   (ctx, payload) => { /* payload is { text: string } *\/ },
 *   { validator: v.object({ text: v.string() }) },
 * );
 * ```
 *
 * **Form 2 — parse function** (return the parsed value or throw):
 * ```ts
 * incoming(
 *   'send-message',
 *   (ctx, payload) => { /* payload is { text: string } *\/ },
 *   {
 *     validator: (raw) => {
 *       const obj = raw as Record<string, unknown>;
 *       if (typeof obj.text !== 'string') throw new Error('text required');
 *       return { text: obj.text };
 *     },
 *   },
 * );
 * ```
 */
export type Validator<T = any> = StandardSchemaV1<unknown, T> | ((value: unknown) => T);
