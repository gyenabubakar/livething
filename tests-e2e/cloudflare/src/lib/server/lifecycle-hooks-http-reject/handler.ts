import { server } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';

export const rejectHttpHandler = withLifecycle(server<Env>('reject-http-test'))
  .onUpgrade(() => {
    throw RejectUpgrade(403, 'Forbidden HTTP upgrade');
  })
  .build();
