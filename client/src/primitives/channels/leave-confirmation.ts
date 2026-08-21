import type { WireMessage } from '~/internal/runtime.ts';

const preserveReceiptState = Symbol('wskit:preserve-receipt-state');

type MarkedMessage = WireMessage & {
  [preserveReceiptState]?: boolean;
};

/** Mark a matching leave confirmation whose queued rejoin is now in flight. */
export function markRejoinConfirmation(message: WireMessage): WireMessage {
  return { ...message, [preserveReceiptState]: true } as MarkedMessage;
}

/** Receipt primitives may preserve state only for the matching leave confirmation. */
export function isRejoinConfirmation(message: WireMessage): boolean {
  return (message as MarkedMessage)[preserveReceiptState] === true;
}
