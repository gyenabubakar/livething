// The polls plugin a host imports, as the Plugins overview page (polls/index.ts) wraps it in step 3.
import { plugin } from '@livething/server/plugins';
import { pollsDefinition } from './polls-definition';

export const Polls = plugin('acme:polls', { definition: pollsDefinition });
