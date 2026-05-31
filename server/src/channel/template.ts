import { WSKitConfigError } from '@wskit/core';

/**
 * Channel family templates use a tiny, fixed syntax that wskit compiles itself
 * — no raw regex from developers, so catastrophic backtracking is impossible by
 * construction. The grammar is just literals plus `{name}` captures:
 *
 * - `room:{id}`            matches `room:general` → `{ id: 'general' }`
 * - `org:{org}/t:{tid}`    matches `org:acme/t:42` → `{ org: 'acme', tid: '42' }`
 * - `cfg{{x}}`             `{{`/`}}` are literal braces → matches `cfg{x}`
 *
 * Each `{name}` matches one or more characters (lazily up to the next literal,
 * greedily to the end when trailing), the same reach the old `.+` regex had. A
 * literal must separate two params so a multi-param template is never ambiguous.
 */
export interface CompiledChannelTemplate {
  /** The original template string, kept for error messages and reconstruction. */
  readonly template: string;
  /** The compiled matcher. Anchored and built only from escaped literals and
   * `(?<name>.+?)` groups, so it is always linear-to-quadratic — never
   * exponential — regardless of the template. */
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
 * Parse a channel family template into a safe matcher. Throws `WSKitConfigError`
 * with a clear message on any malformed template — unclosed/unmatched brace,
 * empty `{}`, bad param name, duplicate param, or two params with no literal
 * between them.
 */
export function compileChannelTemplate(
  template: string,
  source = 'scope()',
): CompiledChannelTemplate {
  if (typeof template !== 'string' || template.length === 0) {
    throw new WSKitConfigError(
      `[wskit] ${source} requires a non-empty template string — got ${JSON.stringify(template)}.`,
    );
  }

  let regexSource = '^';
  const paramNames: string[] = [];
  let literal = '';
  let previousWasParam = false;
  let i = 0;

  function flushLiteral(): void {
    if (literal !== '') {
      regexSource += escapeLiteral(literal);
      literal = '';
    }
  }

  while (i < template.length) {
    const char = template[i];

    if (char === '{') {
      // `{{` is an escaped literal brace.
      if (template[i + 1] === '{') {
        literal += '{';
        previousWasParam = false;
        i += 2;
        continue;
      }
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        throw new WSKitConfigError(
          `[wskit] ${source} template "${template}" has an unclosed '{'. ` +
            `Write '{{' for a literal '{'.`,
        );
      }
      const name = template.slice(i + 1, end);
      if (name === '') {
        throw new WSKitConfigError(
          `[wskit] ${source} template "${template}" has an empty '{}'. ` +
            `Name the parameter, e.g. '{id}'.`,
        );
      }
      if (!PARAM_NAME.test(name)) {
        throw new WSKitConfigError(
          `[wskit] ${source} template "${template}" has an invalid parameter name '${name}'. ` +
            `Use a plain identifier (letters, digits, underscore; not starting with a digit).`,
        );
      }
      if (paramNames.includes(name)) {
        throw new WSKitConfigError(
          `[wskit] ${source} template "${template}" declares the parameter '${name}' twice. ` +
            `Each parameter name must be unique.`,
        );
      }
      if (previousWasParam) {
        throw new WSKitConfigError(
          `[wskit] ${source} template "${template}" has two parameters with no text between them. ` +
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
      // `}}` is an escaped literal brace; a lone `}` is an error.
      if (template[i + 1] === '}') {
        literal += '}';
        previousWasParam = false;
        i += 2;
        continue;
      }
      throw new WSKitConfigError(
        `[wskit] ${source} template "${template}" has an unmatched '}'. ` +
          `Write '}}' for a literal '}'.`,
      );
    }

    literal += char;
    previousWasParam = false;
    i += 1;
  }

  flushLiteral();
  regexSource += '$';

  return { template, regex: new RegExp(regexSource), paramNames };
}
