export function normalizeBinary(
  message: string | ArrayBuffer | ArrayBufferView,
): ArrayBuffer {
  if (message instanceof ArrayBuffer) return message;
  if (ArrayBuffer.isView(message)) {
    return message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength,
    ) as ArrayBuffer;
  }
  return new TextEncoder().encode(message).buffer as ArrayBuffer;
}
