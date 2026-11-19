/**
 * The build-time checks `assemble()` runs over a host's listed capabilities.
 *
 * They live apart from `plugins.ts` because that module is a package entry
 * (`@livething/server/plugins`), so a bundler keeps it whole: importing one function
 * from it would pull the plugin factory, the wire-namespacing pass, and the
 * plugin-scoped context into every app, plugins or not.
 */
import { LiveThingConfigError } from '@livething/core';
import {
  capabilityDisplayName,
  CHANNEL_ONLY_CAPABILITY_KINDS,
} from '~/_define/capability-kinds.ts';
import type { AnyCapability } from '~/_define/capability.ts';
import type { PluginCapability } from '~/_define/plugins.ts';

/**
 * Verify that every plugin listed in a host's `capabilities[]` has its
 * `dependsOn` prerequisites satisfied by another listed capability.
 * A missing prerequisite is a build error at `assemble()`, never a runtime
 * surprise.
 *
 * Matching is by stable capability identity: each factory and the capability it
 * produces share a `__capabilityKind` token (see `withCapabilityKind` /
 * `stampKind`). The matcher reads the token off each `dependsOn` factory WITHOUT
 * calling it — so an arg-requiring factory such as `keepalive` never crashes —
 * and compares against the tokens of the host's listed capabilities. Distinct
 * tokens per stream variant mean `dependsOn: [recordedStream]` is never
 * satisfied by a host that lists only `stream()`.
 */
export function assertPluginDependencies(capabilities: readonly AnyCapability[]): void {
  const present = new Set<string>();
  for (const cap of capabilities) {
    if (cap.__capabilityKind) present.add(cap.__capabilityKind);
  }

  for (const cap of capabilities) {
    const pluginCap = cap as Partial<PluginCapability>;
    if (!pluginCap.__pluginId || !pluginCap.__pluginRequiredKinds) continue;

    for (const kind of pluginCap.__pluginRequiredKinds) {
      if (present.has(kind)) continue;

      const name = capabilityDisplayName(kind);
      throw new LiveThingConfigError(
        `plugin('${pluginCap.__pluginId}') needs the ${name} capability the host does not ` +
          `list. Add ${name} to server({ capabilities: [...] }) — a plugin declares prerequisites ` +
          'instead of owning host engines.',
      );
    }
  }
}

/**
 * Backstop the compile gate on `ServerConfig.capabilities` /
 * `ScopedServerConfig.capabilities`: a channel-only capability (`inbox()`,
 * `readReceipts()`, `awareness()`) listed at the host or plugin top level throws a clear
 * build error. Covers the dynamic case where a capability array is built at
 * runtime and the `__channelOnly` brand never fires at the call site.
 */
export function assertNoChannelOnlyCapabilities(capabilities: readonly AnyCapability[]): void {
  for (const cap of capabilities) {
    const kind = cap.__capabilityKind;
    if (!kind || !CHANNEL_ONLY_CAPABILITY_KINDS.has(kind)) continue;

    const name = capabilityDisplayName(kind);
    throw new LiveThingConfigError(
      `${name} is channel-only. List it in a channel's own \`capabilities\` array — ` +
        `base.channel(name, { capabilities: [${name}] }) — not in server({ capabilities: [...] }).`,
    );
  }
}

/**
 * A plugin's `id` is the namespace it owns on the wire, so no two plugins listed
 * on one host may share it. This catches a duplicate id at `assemble()` — for
 * every plugin, whether or not it declares an `api` or any handlers — with one
 * clear message, instead of leaving it to a later, partial engine-boot check.
 */
export function assertUniquePluginIds(capabilities: readonly AnyCapability[]): void {
  const seen = new Set<string>();
  for (const cap of capabilities) {
    const id = (cap as Partial<PluginCapability>).__pluginId;
    if (id === undefined) continue;

    if (seen.has(id)) {
      throw new LiveThingConfigError(
        `plugin('${id}') is listed more than once. Each plugin id owns a namespace and ` +
          'must be unique — list it once, or give the second one a different id.',
      );
    }

    seen.add(id);
  }
}
