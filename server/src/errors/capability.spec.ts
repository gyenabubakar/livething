import { define } from '~/_define/define.ts';
import { plugin } from '~/_define/plugins.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';

const NotFound = error('not-found', v.object({ id: v.string() }));
const Forbidden = error('forbidden', v.object({ reason: v.string() }));
const NotFoundAgain = error('not-found', v.object({ id: v.number() }));

describe('errors() duplicate error-code build guard', () => {
  it('throws when one errors([...]) call lists the same code twice', () => {
    expect(() => errors([NotFound, NotFoundAgain])).toThrow(/duplicate error code "not-found"/);
  });

  it('accepts distinct codes in one call', () => {
    expect(() => errors([NotFound, Forbidden])).not.toThrow();
  });

  it('rejects errors() when it is listed more than once', () => {
    const capabilities: AnyCapability[] = [errors([NotFound]), errors([Forbidden])];
    expect(() => define({ capabilities })).toThrow(/errors\(\) is listed more than once/);
  });

  it('does not false-positive across plugin and host code boundaries', () => {
    const h = define({ scope: 'plugin', capabilities: [errors([NotFound])] });
    const Denied = plugin('acme:denied', { handler: h.assemble({ handlers: [] }) });

    // host declares its own 'not-found' while the plugin namespaces its code to
    // '__acme:denied::not-found' — distinct wire codes, so no collision.
    const base = define({ capabilities: [errors([NotFound]), Denied()] });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });
});
