import { contract, implement } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';

export const rejectHttpContract = contract<Env>('reject-http-test')({
  definitions: [],
});

export const rejectHttpHandler = implement(rejectHttpContract)
  .onUpgrade(() => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  })
  .build();
