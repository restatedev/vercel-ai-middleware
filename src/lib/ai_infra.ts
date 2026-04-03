import {
  type Serde,
  type Context,
  type RunOptions,
  TerminalError,
} from '@restatedev/restate-sdk';
import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
} from '@ai-sdk/provider';

import superjson from 'superjson';
import { type StepResult, type TypedToolError, type ToolSet } from 'ai';

export type DoGenerateResponseType = Awaited<
  ReturnType<LanguageModelV3['doGenerate']>
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

export const BATCH_TOOL_NAME = '__restate_batch';

/**
 * Creates a middleware that provides durability to LLM calls and enables
 * parallel tool call execution with Restate's deterministic replay guarantees.
 *
 * This middleware:
 * - Wraps each `doGenerate` call in `ctx.run()` for durable replay
 * - When the LLM returns multiple tool calls, rewrites them into a single
 *   batch tool call (so the SDK doesn't use `Promise.all`)
 * - Before the next LLM call, expands batch results back into individual
 *   tool calls/results so the model sees normal conversation history
 *
 * Use together with {@link durableToolCalls} to wrap your tools.
 *
 * @param ctx the restate context
 * @param opts retry options for the `doGenerate` method
 * @returns a LanguageModelV3Middleware
 */
export const durableCalls = (
  ctx: Context,
  opts?: RunOptions<DoGenerateResponseType>,
): LanguageModelV3Middleware => {
  const runOpts = {
    serde: new SuperJsonSerde<DoGenerateResponseType>(),
    ...(opts ?? {maxRetryAttempts: 10, initialRetryInterval: { milliseconds: 1000 }}),
  };

  return {
    specificationVersion: 'v3',

    transformParams: async ({
      params,
    }: {
      type: 'generate' | 'stream';
      params: LanguageModelV3CallOptions;
    }) => {
      // Expand any __restate_batch tool calls/results back to individual ones
      const expandedPrompt = expandBatchMessages(params.prompt);

      // Strip __restate_batch from tools sent to the model
      const filteredTools = params.tools?.filter(
        (t) => !('name' in t && t.name === BATCH_TOOL_NAME),
      );

      return {
        ...params,
        prompt: expandedPrompt,
        tools: filteredTools,
      };
    },

    wrapGenerate: async ({ model, doGenerate }) => {
      // Make the LLM call durable
      const result = await ctx.run(
        `calling ${model.provider}`,
        async () => doGenerate(),
        runOpts,
      );

      // Count tool calls in the response
      const toolCalls = result.content.filter(
        (part) => part.type === 'tool-call',
      );

      // Only batch when there are multiple tool calls
      if (toolCalls.length <= 1) {
        return result;
      }

      // Rewrite N tool calls into a single __restate_batch tool call
      const batchInput = {
        calls: toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: JSON.parse(tc.input),
        })),
      };

      const nonToolCallContent = result.content.filter(
        (part) => part.type !== 'tool-call',
      );

      return {
        ...result,
        content: [
          ...nonToolCallContent,
          {
            type: 'tool-call' as const,
            toolCallId: `${BATCH_TOOL_NAME}_${toolCalls[0]!.toolCallId}`,
            toolName: BATCH_TOOL_NAME,
            input: JSON.stringify(batchInput),
          },
        ],
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Internal: Message expansion for transformParams
// ---------------------------------------------------------------------------

interface BatchResultEntry {
  toolCallId: string;
  toolName: string;
  status: 'fulfilled' | 'rejected';
  result?: unknown;
  error?: string;
}

interface BatchInput {
  calls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
}

function expandBatchMessages(
  prompt: LanguageModelV3CallOptions['prompt'],
): LanguageModelV3CallOptions['prompt'] {
  return prompt.map((message) => {
    if (message.role === 'assistant') {
      return expandAssistantMessage(message);
    }
    if (message.role === 'tool') {
      return expandToolMessage(message);
    }
    return message;
  });
}

function expandAssistantMessage(
  message: Extract<LanguageModelV3Message, { role: 'assistant' }>,
): LanguageModelV3Message {
  const hasBatch = message.content.some(
    (part) =>
      part.type === 'tool-call' && part.toolName === BATCH_TOOL_NAME,
  );
  if (!hasBatch) return message;

  const expandedContent = message.content.flatMap((part) => {
    if (part.type !== 'tool-call' || part.toolName !== BATCH_TOOL_NAME) {
      return [part];
    }
    const batchInput = part.input as BatchInput;
    return batchInput.calls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.args,
    }));
  });

  return { ...message, content: expandedContent };
}

function expandToolMessage(
  message: Extract<LanguageModelV3Message, { role: 'tool' }>,
): LanguageModelV3Message {
  const hasBatch = message.content.some(
    (part) =>
      part.type === 'tool-result' && part.toolName === BATCH_TOOL_NAME,
  );
  if (!hasBatch) return message;

  const expandedContent = message.content.flatMap((part) => {
    if (part.type !== 'tool-result' || part.toolName !== BATCH_TOOL_NAME) {
      return [part];
    }

    const batchResults = extractBatchResults(part.output);
    return batchResults.map((entry) => {
      if (entry.status === 'fulfilled') {
        return {
          type: 'tool-result' as const,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          output: {
            type: 'json' as const,
            value: (entry.result ?? null) as import('@ai-sdk/provider').JSONValue,
          },
        };
      }
      return {
        type: 'tool-result' as const,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        output: {
          type: 'error-text' as const,
          value: entry.error ?? 'Unknown error',
        },
      };
    });
  });

  return { ...message, content: expandedContent };
}

function extractBatchResults(
  output: import('@ai-sdk/provider').LanguageModelV3ToolResultOutput,
): BatchResultEntry[] {
  if (output.type === 'json') {
    return output.value as unknown as BatchResultEntry[];
  }
  if (output.type === 'text') {
    return JSON.parse(output.value) as BatchResultEntry[];
  }
  return [];
}

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
