import { assertSynchronousResult, WSKitConfigError } from '@wskit/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

export interface Translator<TState = unknown> {
  inbound(raw: string): string | null;
  outbound?(outgoing: string): string | null;
  hibernation?: {
    serialize(): TState;
    restore(state: NoInfer<TState> | undefined): void;
  };
}

export type TranslatorFactory<TState = unknown> = () => Translator<TState>;

export class TranslationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationInputError';
  }
}

type TranslatorDefinition<TState> = Omit<Translator<TState>, 'inbound'> & {
  inbound(raw: string): string | null;
  input?: undefined;
};

type ValidatedTranslatorDefinition<TSchema extends Validator, TState> = Omit<
  Translator<TState>,
  'inbound'
> & {
  input: TSchema;
  inbound(frame: StandardSchemaV1.InferOutput<NoInfer<TSchema>>): string | null;
};

type TranslatorDefinitionFor<
  TState,
  TSchema extends Validator | undefined,
> = TSchema extends Validator
  ? ValidatedTranslatorDefinition<TSchema, TState>
  : TranslatorDefinition<TState>;

export function translator<TState = unknown, TSchema extends Validator | undefined = undefined>(
  factory: () => TranslatorDefinitionFor<TState, TSchema>,
): TranslatorFactory<TState>;
export function translator(
  factory: () => TranslatorDefinition<unknown> | ValidatedTranslatorDefinition<Validator, unknown>,
) {
  return () => {
    const definition = assertDefinition(factory());
    const input = definition.input;
    const instance: Translator = {
      inbound(raw) {
        const value = input === undefined ? raw : validateInput(input, raw);
        return assertTranslatedString(
          assertSynchronousResult(definition.inbound(value as never), 'translator.inbound'),
          'translator.inbound',
        );
      },
    };

    if (definition.outbound) {
      instance.outbound = (outgoing) =>
        assertTranslatedString(
          assertSynchronousResult(definition.outbound!(outgoing), 'translator.outbound'),
          'translator.outbound',
        );
    }

    if (definition.hibernation) {
      instance.hibernation = {
        serialize() {
          return assertSynchronousResult(
            definition.hibernation!.serialize(),
            'translator.hibernation.serialize',
          );
        },
        restore(state) {
          assertSynchronousResult(
            definition.hibernation!.restore(state),
            'translator.hibernation.restore',
          );
        },
      };
    }

    return instance;
  };
}

function assertDefinition(
  definition: TranslatorDefinition<unknown> | ValidatedTranslatorDefinition<Validator, unknown>,
): TranslatorDefinition<unknown> | ValidatedTranslatorDefinition<Validator, unknown> {
  if (!definition || typeof definition !== 'object' || typeof definition.inbound !== 'function') {
    throw new WSKitConfigError('translator() factory must return an object with inbound(raw).');
  }

  if (definition.outbound !== undefined && typeof definition.outbound !== 'function') {
    throw new WSKitConfigError('translator outbound must be a function when provided.');
  }

  if (
    definition.hibernation !== undefined &&
    (!definition.hibernation ||
      typeof definition.hibernation !== 'object' ||
      typeof definition.hibernation.serialize !== 'function' ||
      typeof definition.hibernation.restore !== 'function')
  ) {
    throw new WSKitConfigError(
      'translator hibernation must provide both serialize() and restore().',
    );
  }

  if (definition.input !== undefined && !isValidator(definition.input)) {
    throw new WSKitConfigError('translator input must be a Standard Schema validator.');
  }

  return definition;
}

function isValidator(value: unknown): value is Validator {
  return (
    !!value &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
  );
}

function validateInput(input: Validator, raw: string): unknown {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    throw new TranslationInputError('[wskit] translator input rejected invalid JSON.');
  }

  const result = assertSynchronousResult(
    input['~standard'].validate(frame),
    'translator input',
    'validator',
  );
  if (result.issues) {
    throw new TranslationInputError(
      `[wskit] translator input rejected frame: ${result.issues[0]?.message ?? 'invalid input'}`,
    );
  }

  return result.value;
}

function assertTranslatedString(value: unknown, method: string): string | null {
  if (typeof value === 'string' || value === null) return value;

  throw new WSKitConfigError(`${method} must return a string or null.`);
}
