// Huddle's client Collaboration plugin, as `client/huddle-collab.ts` on the Huddle reference
// page shows it.
import { collaboration, indexedDbStorage } from '@livething/plugin-collaboration/client';
import { huddleDocs } from './huddle-docs';

export const HuddleCollaboration = collaboration({
  docs: huddleDocs,
  storage: indexedDbStorage(),
});
