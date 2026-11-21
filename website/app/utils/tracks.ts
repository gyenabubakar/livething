import type { ContentNavigationItem } from '@nuxt/content';

// The docs come in two tracks, each a content root under `content/<n>.<track>` with its
// own URL prefix: `/core/...` and `/plugins/...`. The header tabs switch between them,
// and the section bar and the sidebar show only the current track.
export type Track = 'core' | 'plugins';

export interface TrackInfo {
  value: Track;
  label: string;
  icon: string;
  /** The page a tab opens. */
  to: string;
}

export const tracks: TrackInfo[] = [
  { value: 'core', label: 'Core', icon: 'i-ph-brackets-angle-duotone', to: '/core/start/introduction' },
  { value: 'plugins', label: 'Plugins', icon: 'i-ph-plug-duotone', to: '/plugins/collaboration/overview' },
];

export function trackForPath(path: string): Track | undefined {
  return tracks.find((track) => path === `/${track.value}` || path.startsWith(`/${track.value}/`))?.value;
}

/** The sections of the track `path` is in. A path outside both tracks gets Core, as the tabs do. */
export function trackNavigation(
  roots: ContentNavigationItem[] | null | undefined,
  path: string,
): ContentNavigationItem[] {
  const track = trackForPath(path) ?? 'core';
  return roots?.find((root) => root.path === `/${track}`)?.children ?? roots ?? [];
}
