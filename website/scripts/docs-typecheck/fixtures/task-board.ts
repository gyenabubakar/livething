// The general room's task board, as `client/task-board.ts` on the Collaboration client page
// shows it.
import { HuddleCollaboration } from './huddle-collab';
import { socket } from './socket';

export const collab = HuddleCollaboration.use(socket);
export const board = collab.doc('task-board', 'general');
