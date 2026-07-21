import {
  type Serde,
  type Context,
  type RunOptions,
  TerminalError,
} from '@restatedev/restate-sdk';
import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
} from '@ai-sdk/provider';

import superjson from 'superjson';
import { type StepResult, type TypedToolError, type ToolSet } from 'ai';

export type DoGenerateResponseType = Awaited<
  ReturnType<LanguageModelV4['doGenerate']>
>;

export class SuperJsonSerde<T> implements Serde<T> {
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
 * `doGenerate` method of a LanguageModelV4 instance.
 * @param ctx the restate context used to capture the execution of the `doGenerate` method.
 * @param opts retry options for the `doGenerate` method.
 * @returns an LanguageModelV4Middleware that provides durability to the underlying model.
 */
export const durableCalls = (
  ctx: Context,
  opts?: RunOptions<DoGenerateResponseType>,
): LanguageModelV4Middleware => {
  const runOpts = {
    serde: new SuperJsonSerde<DoGenerateResponseType>(),
    ...opts,
  };

  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ model, doGenerate }) =>
      ctx.run(`calling ${model.provider}`, async () => doGenerate(), runOpts),
  };
};

function isTerminalError(err: unknown) {
  if (err instanceof TerminalError) {
    return true;
  }

  // When using cloudflare workers with this integration,
  // the above 'err instanceof TerminalError' will not match, because
  // `TerminalError` from `@restatedev/restate-sdk` is different from
  // `TerminalError` from `@restatedev/restate-sdk-cloudflare-workers`.
  const e = err as Error & { code?: number };
  return (
    (e?.name === 'TerminalError' && e?.code !== undefined) ||
    (e?.name === 'TimeoutError' && e?.code === 408) ||
    (e?.name === 'CancelledError' && e?.code === 409)
  );
}

const getFirstTerminalToolErrorForStep = <TOOLS extends ToolSet>(
  step: StepResult<TOOLS>,
) =>
  step.content.find(
    (el) => el.type === 'tool-error' && isTerminalError(el.error),
  ) as TypedToolError<TOOLS> | undefined;

export const getTerminalToolSteps = <TOOLS extends ToolSet>(
  steps: StepResult<TOOLS>[],
) =>
  steps.filter((step) => getFirstTerminalToolErrorForStep(step) != undefined);

export const hasTerminalToolError = <TOOLS extends ToolSet>({
  steps,
}: {
  steps: StepResult<TOOLS>[];
}) =>
  steps.some((step) => getFirstTerminalToolErrorForStep(step) !== undefined);

export const rethrowTerminalToolError = <TOOLS extends ToolSet>(
  step: StepResult<TOOLS>,
) => {
  const terminalStep = getFirstTerminalToolErrorForStep(step);
  if (!terminalStep) {
    return;
  }
  // Rethrow the terminal error
  throw terminalStep.error;
};
