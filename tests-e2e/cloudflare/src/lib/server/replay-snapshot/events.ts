import * as v from 'valibot';

export const UpdateDoc = v.object({ docId: v.string(), title: v.string() });
export const DocSnapshot = v.object({ docId: v.string(), title: v.string() });
export const DeleteDoc = v.object({ docId: v.string() });
export const DocDeleted = v.object({ docId: v.string() });

export const IncrementCounter = v.object({ key: v.string(), amount: v.number() });
export const CounterSnapshot = v.object({ key: v.string(), total: v.number() });

export const RoomUpdateDoc = v.object({ docId: v.string(), title: v.string() });
export const RoomDocSnapshot = v.object({ docId: v.string(), title: v.string() });
