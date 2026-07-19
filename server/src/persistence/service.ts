import {
  autoRejoinIdentity,
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
  purgeUser,
} from '~/persistence/membership.ts';
import { restorePersistentTags } from '~/persistence/rejoin.ts';
import type { PersistenceService } from '~/_engine/runtime/feature-slots.ts';

/**
 * The durable membership + persistent-tag operations, bundled so the engine can
 * reach them through one slot. Registered by `persistence()`; a handler without
 * it never pulls the membership/rejoin/storage code into its bundle.
 */
export const persistenceService: PersistenceService = {
  persistMembership,
  deleteDurableMembership,
  hasDurableMembership,
  autoRejoinIdentity,
  restorePersistentTags,
  purgeUser,
};
