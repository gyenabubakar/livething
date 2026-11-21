import { DocCore } from '~/doc/core.ts';
import { applyChecked } from '~/server/check.ts';
import { open, task, taskBoard } from '~/test/task-board.ts';
import { bench, describe } from 'vitest';
import * as Y from 'yjs';

// What the doc core costs on a big board: 5,000 tasks, about 1.2 MiB.
const ROUNDS = 400;
const client = open(taskBoard);
client.change((d) => {
  for (let i = 0; i < 5000; i += 1) d.tasks.push({ ...task(`t${i}`), notes: 'Some notes here' });
});

/** The updates of `ROUNDS` client edits, made ahead, so a bench times only the server check. */
function updates(edit: (round: number) => void): Uint8Array[] {
  return Array.from({ length: ROUNDS }, (_, round) => {
    const before = Y.encodeStateVector(client.ydoc);
    edit(round);
    return Y.encodeStateAsUpdate(client.ydoc, before);
  });
}

const start = Y.encodeStateAsUpdate(client.ydoc);
const edits = updates((round) =>
  client.change((d) => {
    const t = d.tasks.at(round)!;
    t.done = true;
    t.title = `Task number ${round}, edited`;
  }),
);
const moves = updates((round) => client.change((d) => d.tasks.move(round, 4000 - round)));

function checker(list: readonly Uint8Array[]) {
  const server = new DocCore(taskBoard);
  applyChecked(server, start, 'client');
  if (list === moves) for (const update of edits) applyChecked(server, update, 'client');

  let next = 0;

  return () => {
    const result = applyChecked(server, list[next % list.length]!, 'client');
    next += 1;
    if (!result.ok) throw new Error(result.reason);
  };
}

describe('a 5,000-task board', () => {
  // Each update can be checked once, so no warm-up runs.
  const once = { iterations: ROUNDS, time: 0, warmupIterations: 0, warmupTime: 0 };
  bench('the server check of an edit', checker(edits), once);
  bench('the server check of a move', checker(moves), once);

  let round = 0;
  bench('a client change() and its new snapshot', () => {
    round += 1;
    client.change((d) => {
      const t = d.tasks.at(round % 5000)!;
      t.done = !t.done;
    });
  });
});
