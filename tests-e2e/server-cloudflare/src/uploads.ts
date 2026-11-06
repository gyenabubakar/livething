import { bind } from '@livething/server-cloudflare';
import { uploadsDefinition, uploadsExpiryDefinition } from '@livething/tests-e2e-handlers/uploads';

export class UploadsServer extends bind(uploadsDefinition) {}

export class UploadsExpiryServer extends bind(uploadsExpiryDefinition) {}
