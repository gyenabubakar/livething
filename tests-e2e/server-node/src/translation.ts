import {
  translationHandler,
  translationInboundOnlyHandler,
  translationPassThroughHandler,
} from '@wskit/tests-e2e-handlers/translation';
import { bind } from './bind.ts';

export const createTranslationServer = bind(translationHandler);
export const createTranslationPassThroughServer = bind(translationPassThroughHandler);
export const createTranslationInboundOnlyServer = bind(translationInboundOnlyHandler);
