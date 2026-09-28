import { capabilityDisplayName } from '~/_define/capability-kinds.ts';
import type { AnyCapability } from '~/_define/capability.ts';

export function assertUniqueCapabilityKinds(
  capabilities: readonly AnyCapability[],
  context: string,
): void {
  const seen = new Set<string>();

  for (const capability of capabilities) {
    const kind = capability.__capabilityKind;
    if (!kind) continue;

    if (seen.has(kind)) {
      throw new Error(
        `[livething] ${capabilityDisplayName(kind)} is listed more than once in ${context}. ` +
          'Each capability can be listed once per scope.',
      );
    }

    seen.add(kind);
  }
}
