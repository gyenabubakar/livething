import { hibernation } from '~/hibernation/hibernation.ts';

const enabled = hibernation();
const disabled = hibernation(false);

const _tag: 'hibernation' = enabled.__wskit;
const _enabled: boolean = enabled.enabled;
const _disabled: boolean = disabled.enabled;
const _requiresHibernation: boolean | undefined = enabled.__requires.hibernation;
void [_tag, _enabled, _disabled, _requiresHibernation];
