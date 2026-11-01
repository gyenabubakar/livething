// The Durable Object classes of the Cloudflare adapter page.
import { bind } from '@livething/server-cloudflare';
import { huddle } from './huddle-definition';
import { presence } from './presence-definition';

export class HuddleServer extends bind(huddle) {}
export class Presence extends bind(presence) {}
