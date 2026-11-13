// The same code as `client/upload-until-done.ts` on the client uploads page, which other
// upload examples import.
import { Disconnected } from '@livething/client/errors';
import type { ConnectionState, Upload } from '@livething/client';
import { socket } from './socket';

/** Resolves when the socket is open again, and rejects when nothing reconnects it. */
export function whenReconnected(): Promise<void> {
  return new Promise((resolve, reject) => {
    function settled(state: ConnectionState): boolean {
      if (state === 'open') resolve();
      else if (state === 'closed') reject(Disconnected());
      else return false;

      return true;
    }

    if (settled(socket.state.get())) return;

    const stop = socket.state.subscribe((state) => {
      if (settled(state)) stop();
    });
  });
}

/** Starts the upload, and starts it again after each drop, until the server replies. */
export async function uploadUntilDone<TInfo>(upload: Upload<TInfo>): Promise<TInfo> {
  for (;;) {
    try {
      const { info } = await upload.start();

      return info;
    } catch (error) {
      if (!Disconnected.matches(error)) throw error;

      await whenReconnected();
    }
  }
}
