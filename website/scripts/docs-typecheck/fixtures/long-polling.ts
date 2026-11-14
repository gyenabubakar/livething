// The long-polling transport of the Custom Transports page. The server file and the client
// file both export `longPolling()`, so this one stands for both.
import type { TransportFactory } from '@livething/client';
import type { ServerTransport } from '@livething/server/adapters';

export declare function longPolling(): ServerTransport & TransportFactory;
