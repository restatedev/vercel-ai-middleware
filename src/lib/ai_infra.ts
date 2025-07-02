import * as restate from '@restatedev/restate-sdk';
import type { LanguageModelV1, LanguageModelV1Middleware } from 'ai';
import superjson from 'superjson';

export type DoGenerateResponseType = Awaited<
  ReturnType<LanguageModelV1['doGenerate']>
>;

class SuperJsonSerde<T> implements restate.Serde<T> {
  contentType = 'application/json';

  serialize(value: T): Uint8Array {
    const js = superjson.stringify(value);
    return new TextEncoder().encode(js);
  }

  deserialize(data: Uint8Array): T {
    const js = new TextDecoder().decode(data);
    return superjson.parse(js) as T;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const superJson = new SuperJsonSerde<any>();

/**
 * The following function is a middleware that provides durability to the results of a
 * `doGenerate` method of a LanguageModelV1 instance.
 * @param ctx the restate context used to capture the execution of the `doGenerate` method.
 * @param opts retry options for the `doGenerate` method.
 * @returns an LanguageModelV1Middleware that provides durability to the underlying model.
 */
export const durableCalls = (
  ctx: restate.Context,
  opts?: restate.RunOptions<DoGenerateResponseType>,
): LanguageModelV1Middleware => {
  const runOpts = {
    serde: new SuperJsonSerde<DoGenerateResponseType>(),
    ...opts,
  };

  return {
    wrapGenerate({ model, doGenerate }) {
      return ctx.run(
        `calling ${model.provider}`,
        async () => doGenerate(),
        runOpts,
      );
    },
  };
};
