const translatorConfigErrors = new WeakSet<object>();

export function markTranslatorConfigError(error: object): void {
  translatorConfigErrors.add(error);
}

export function isTranslatorConfigError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && translatorConfigErrors.has(error);
}
