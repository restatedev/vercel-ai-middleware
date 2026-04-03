import {
  RestatePromise,
  TerminalError,
} from '@restatedev/restate-sdk';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { BATCH_TOOL_NAME } from './ai_infra';

const schemaSymbol = Symbol.for('vercel.ai.schema');

interface BatchCallEntry {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface BatchInput {
  calls: BatchCallEntry[];
}

interface BatchResultEntry {
  toolCallId: string;
  toolName: string;
  status: 'fulfilled' | 'rejected';
  result?: unknown;
  error?: string;
}

type BatchOutput = BatchResultEntry[];

/**
 * Wraps a tool set for durable parallel execution with Restate.
 *
 * Returns the same tools plus an internal `__restate_batch` tool that the
 * {@link durableCalls} middleware uses to execute parallel tool calls via
 * `RestatePromise.allSettled()`.
 *
 * Tool `execute` functions MUST return a `RestatePromise` (i.e., must NOT be
 * declared `async`). Use {@link durableTool} to wrap plain functions.
 *
 * @example
 * ```ts
 * const model = wrapLanguageModel({
 *   model: openai("gpt-4o"),
 *   middleware: durableCalls(ctx),
 * });
 *
 * const { text } = await generateText({
 *   model,
 *   tools: durableToolCalls(ctx, {
 *     myTool: tool({
 *       parameters: z.object({ query: z.string() }),
 *       execute: (input) => ctx.run("myTool", () => doWork(input)),
 *     }),
 *   }),
 * });
 * ```
 */
export function durableToolCalls<TOOLS extends ToolSet>(
  tools: TOOLS,
): TOOLS & Record<typeof BATCH_TOOL_NAME, ToolSet[string]> {
  return {
    ...tools,
    [BATCH_TOOL_NAME]: createBatchTool(tools),
  } as TOOLS & Record<typeof BATCH_TOOL_NAME, ToolSet[string]>;
}

// ---------------------------------------------------------------------------
// Internal: Batch Tool
// ---------------------------------------------------------------------------

function createBatchTool(tools: ToolSet): ToolSet[string] {
  return {
    description: 'Internal: Restate durable parallel tool execution',
    type: 'function' as const,
    inputSchema: {
      [schemaSymbol]: true,
      _type: undefined as unknown,
      validate: undefined,
      jsonSchema: {
        type: 'object',
        properties: {
          calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                toolCallId: { type: 'string' },
                toolName: { type: 'string' },
                args: {},
              },
              required: ['toolCallId', 'toolName', 'args'],
            },
          },
        },
        required: ['calls'],
      },
    } as unknown as ToolSet[string]['inputSchema'],
    execute: (
      input: BatchInput,
      options: ToolExecutionOptions,
    ): RestatePromise<BatchOutput> => {
      const promises = input.calls.map((call) => {
        const tool = tools[call.toolName];
        if (!tool?.execute) {
          throw new TerminalError(
            `Tool "${call.toolName}" not found or has no execute function`,
          );
        }
        // Call the tool's execute — it MUST return RestatePromise (non-async execute)
        return tool.execute(call.args, {
          ...options,
          toolCallId: call.toolCallId,
        }) as RestatePromise<unknown>;
      });

      return RestatePromise.allSettled(promises).map(
        (settledResults?: PromiseSettledResult<unknown>[]) => {
          if (!settledResults) {
            throw new TerminalError('Unexpected: allSettled returned undefined');
          }
          return input.calls.map((call, i) => {
            const settled = settledResults[i]!;
            if (settled.status === 'fulfilled') {
              return {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                status: 'fulfilled' as const,
                result: settled.value,
              };
            }
            return {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'rejected' as const,
              error: String(settled.reason),
            };
          });
        },
      );
    },
  };
}
