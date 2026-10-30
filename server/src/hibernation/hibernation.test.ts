import { hibernation } from '~/hibernation/hibernation.ts';

const primitive = hibernation();

const _tag: 'hibernation' = primitive.__livething;
const _requiresHibernation: boolean | undefined = primitive.__requires.hibernation;
void [_tag, _requiresHibernation];
