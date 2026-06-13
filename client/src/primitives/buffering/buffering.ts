import { MessageBuffer } from '~/primitives/buffering/buffer.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

/** Options for `buffering()`. */
export interface BufferingOptions {
  /** Queue sends made while disconnected. Default: `false`. */
  enabled?: boolean;
  /** Most messages to hold; the oldest is dropped when full. Default: `50`. */
  maxSize?: number;
  /** Time-to-live for queued messages: one number for all, or a per-event map. */
  ttl?: number | Record<string, number>;
  /** Ms between each message on flush. `0` sends them all at once. Default: `0`. */
  flushInterval?: number;
}

/**
 * Keeps messages you send while the socket is down and replays them in order
 * when it reconnects. Opt-in, and it owns the buffer, so the queueing code ships
 * only when you add it.
 */
export function buffering(options: BufferingOptions = {}): Primitive<EmptyTypeFn> {
  return {
    _tag: 'buffering',
    setup(helpers) {
      const buffer = new MessageBuffer({
        enabled: options.enabled,
        maxSize: options.maxSize,
        ttl: options.ttl,
        flushInterval: options.flushInterval,
      });

      // Offered every outgoing message. Take it while the socket is closed, or
      // while a staggered flush is still draining — a live send during the flush
      // must queue behind the not-yet-flushed messages so order is preserved,
      // not race ahead of them onto the wire. Decline otherwise (open and idle),
      // so normal sends go straight to the wire.
      helpers.registerOutgoingFallback((message, options) => {
        if (helpers.getState() === 'open' && !buffer.isFlushing) return false;
        const buffered = buffer.enqueue(message, options?.ttl, options?.owner);
        if (buffered) helpers.log.info(`buffered '${message.event}'`);
        return buffered;
      });

      return {
        id: 'buffering',
        onOpen() {
          helpers.log.info('flushing buffered messages');
          buffer.flush(
            (message) => helpers.rawSend(message),
            undefined,
            (error) => helpers.log.report(error),
          );
          return null;
        },
        onClose(_code, _reason, intentional) {
          // A deliberate disconnect throws the queue away. An accidental drop
          // keeps the queue so the messages go out on reconnect, but still stops
          // any in-progress staggered flush — otherwise its timer would keep
          // firing into a closed socket and silently lose those messages.
          if (intentional) buffer.clear();
          else buffer.stopFlush();
        },
      };
    },
  };
}
buffering.tag = 'buffering';
