import type { Message } from '~/internal/runtime.ts';

const preserveReceiptState = Symbol('livething:preserve-receipt-state');

type MarkedMessage = Message & {
  [preserveReceiptState]?: boolean;
};

/** Mark a matching leave confirmation whose queued rejoin is now in flight. */
export function markRejoinConfirmation(message: Message): Message {
  return { ...message, [preserveReceiptState]: true } as MarkedMessage;
}

/** Receipt primitives may preserve state only for the matching leave confirmation. */
export function isRejoinConfirmation(message: Message): boolean {
  return (message as MarkedMessage)[preserveReceiptState] === true;
}
