/**
 * The build-time checks `assemble()` runs over a host's listed capabilities.
 *
 * They live apart from `plugin.ts` because that module is a package entry
 * (`@wskit/server/plugin`), so a bundler keeps it whole: importing one function
 * from it would pull the plugin factory, the wire-namespacing pass, and the
 * plugin-scoped context into every app, plugins or not.
 */
import {
  capabilityDisplayName,
  CHANNEL_ONLY_CAPABILITY_KINDS,
} from '~/_define/capability-kinds.ts';
import type { AnyCapability } from '~/_define/capability.ts';
import type { PluginCapability } from '~/_define/plugin.ts';

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
 * tokens per stream variant mean `dependsOn: [resumableStream]` is never
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
      throw new Error(
        `[wskit] plugin('${pluginCap.__pluginId}') needs the ${name} capability the host does not ` +
          `list. Add ${name} to define({ capabilities: [...] }) — a plugin declares prerequisites ` +
          'instead of owning host engines.',
      );
    }
  }
}

/**
 * Backstop the compile gate at `assemble()`: a plugin that opted into host
 * observation but was listed without `observeHost(...)` throws a clear build
 * error. Covers the dynamic case where `observesHostTraffic` is a non-literal
 * boolean (the type widens, so the brand never fires). When a grant is present,
 * warn once that the plugin can see the app's frames.
 */
export function assertHostObservationGranted(
  capabilities: readonly AnyCapability[],
  logger: Pick<Console, 'warn'> = console,
): void {
  for (const cap of capabilities) {
    const pluginCap = cap as Partial<PluginCapability>;
    if (!pluginCap.__pluginId || !pluginCap.__observesHostTraffic) continue;
    if (!pluginCap.__hostObservationGranted) {
      throw new Error(
        `[wskit] plugin('${pluginCap.__pluginId}') observes host traffic but was listed without ` +
          'observeHost(...). Wrap it as observeHost(' +
          `${pluginCap.__pluginId}()) in define({ capabilities: [...] }) to grant the privilege.`,
      );
    }
    logger.warn(
      `[wskit] plugin "${pluginCap.__pluginId}" is granted host-traffic observation ` +
        "(its intercept/outgoing see the app's frames)",
    );
  }
}

/**
 * Backstop the compile gate on `DefineConfig.capabilities` /
 * `ScopedDefineConfig.capabilities`: a channel-only capability (`inbox()`,
 * `readReceipts()`) listed at the host or plugin top level throws a clear
 * build error. Covers the dynamic case where a capability array is built at
 * runtime and the `__channelOnly` brand never fires at the call site.
 */
export function assertNoChannelOnlyCapabilities(capabilities: readonly AnyCapability[]): void {
  for (const cap of capabilities) {
    const kind = cap.__capabilityKind;
    if (!kind || !CHANNEL_ONLY_CAPABILITY_KINDS.has(kind)) continue;
    const name = capabilityDisplayName(kind);
    throw new Error(
      `[wskit] ${name} is channel-only. List it in a channel's own \`capabilities\` array — ` +
        `base.channel(name, { capabilities: [${name}] }) — not in define({ capabilities: [...] }).`,
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
      throw new Error(
        `[wskit] plugin('${id}') is listed more than once. Each plugin id owns a namespace and ` +
          'must be unique — list it once, or give the second one a different id.',
      );
    }
    seen.add(id);
  }
}
