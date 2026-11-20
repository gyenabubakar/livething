import { LiveThingConfigError } from '@livething/core';

/**
 * Channel family templates use a tiny, fixed syntax that LiveThing compiles itself
 * — no raw regex from developers, so exponential backtracking is impossible by
 * construction. The grammar is just literals plus `{name}` captures:
 *
 * - `room:{id}`            matches `room:general` → `{ id: 'general' }`
 * - `org:{org}/t:{tid}`    matches `org:acme/t:42` → `{ org: 'acme', tid: '42' }`
 *
 * A brace outside a `{name}` capture is an error; templates have no literal
 * braces. Each `{name}` matches one or more characters (lazily up to the next literal,
 * greedily to the end when trailing). A literal must separate two params so a
 * multi-param template is never ambiguous.
 */
export interface CompiledChannelTemplate {
  /** The original template string, kept for error messages and reconstruction. */
  readonly template: string;
  /** The compiled matcher. Anchored and built only from escaped literals and
   * `(?<name>.+?)` groups. Worst-case matching is polynomial in the name
   * length with the param count as the power (linear for one param,
   * quadratic for two, cubic for three) — never exponential. The 256-character
   * wire limit on channel names bounds it. */
  readonly regex: RegExp;
  /** Capture names, in template order. */
  readonly paramNames: readonly string[];
}

// A `{name}` must be a plain identifier so it is also a valid regex group name.
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Escape every regex metacharacter so literal template text matches literally.
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a channel family template into a safe matcher. Throws `LiveThingConfigError`
 * with a clear message on any malformed template — stray brace,
 * empty `{}`, bad param name, duplicate param, or two params with no literal
 * between them.
 */
export function compileChannelTemplate(
  template: string,
  source = 'base.channel()',
): CompiledChannelTemplate {
  if (typeof template !== 'string' || template.length === 0) {
    throw new LiveThingConfigError(
      `${source} requires a non-empty template string — got ${JSON.stringify(template)}.`,
    );
  }

  let regexSource = '^';
  const paramNames: string[] = [];
  let literal = '';
  let previousWasParam = false;
  let i = 0;

  function strayBrace(brace: '{' | '}'): LiveThingConfigError {
    return new LiveThingConfigError(
      `${source} template "${template}" has a stray '${brace}' that is not part of a ` +
        `'{param}' capture. Channel templates cannot contain literal braces.`,
    );
  }

  function flushLiteral(): void {
    if (literal !== '') {
      regexSource += escapeLiteral(literal);
      literal = '';
    }
  }

  while (i < template.length) {
    const char = template[i];

    if (char === '{') {
      const end = template.indexOf('}', i + 1);
      const name = end === -1 ? '' : template.slice(i + 1, end);
      if (end === -1 || name.includes('{')) {
        throw strayBrace('{');
      }

      if (name === '') {
        throw new LiveThingConfigError(
          `${source} template "${template}" has an empty '{}'. ` +
            `Name the parameter, e.g. '{id}'.`,
        );
      }

      if (!PARAM_NAME.test(name)) {
        throw new LiveThingConfigError(
          `${source} template "${template}" has an invalid parameter name '${name}'. ` +
            `Use a plain identifier (letters, digits, underscore; not starting with a digit).`,
        );
      }

      if (paramNames.includes(name)) {
        throw new LiveThingConfigError(
          `${source} template "${template}" declares the parameter '${name}' twice. ` +
            `Each parameter name must be unique.`,
        );
      }

      if (previousWasParam) {
        throw new LiveThingConfigError(
          `${source} template "${template}" has two parameters with no text between them. ` +
            `Separate them with a literal, e.g. '{a}:{b}'.`,
        );
      }

      flushLiteral();
      regexSource += `(?<${name}>.+?)`;

      paramNames.push(name);
      previousWasParam = true;
      i = end + 1;
      continue;
    }

    if (char === '}') {
      throw strayBrace('}');
    }

    literal += char;
    previousWasParam = false;
    i += 1;
  }

  flushLiteral();
  regexSource += '$';

  // `s`: a param matches any character, a line break too, as a name like `room:a\nb` holds one.
  return { template, regex: new RegExp(regexSource, 's'), paramNames };
}

/**
 * Fill a channel family template with concrete params to produce a channel
 * name — the inverse of the matcher. `room:{id}` + `{ id: 'general' }` →
 * `room:general`. Throws if a declared
 * param is missing or its value is empty, so a `.at(...)` ref never resolves to
 * a malformed name.
 */
export function fillChannelTemplate(
  template: string,
  params: Record<string, string>,
  source = 'base.channel()',
): string {
  let result = '';
  let i = 0;

  while (i < template.length) {
    const char = template[i];

    if (char === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        throw new LiveThingConfigError(
          `${source} template "${template}" has an unclosed '{' — it must be a ` +
            'compiled family template.',
        );
      }

      const name = template.slice(i + 1, end);
      const value = params[name];

      if (typeof value !== 'string' || value === '') {
        throw new LiveThingConfigError(
          `${source} template "${template}" needs a non-empty '${name}' to resolve a ` +
            `channel name — got ${JSON.stringify(value)}.`,
        );
      }

      result += value;
      i = end + 1;
      continue;
    }

    result += char;
    i += 1;
  }

  return result;
}
