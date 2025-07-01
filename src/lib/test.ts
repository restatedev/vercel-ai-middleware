import * as restate from '@restatedev/restate-sdk';

export const testService = restate.service({
  name: 'test',
  handlers: {
    test: async (ctx: restate.Context) => {
      return true;
    },
  },
});
