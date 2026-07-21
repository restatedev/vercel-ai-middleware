import {
  type Context,
  RestatePromise,
  TerminalError,
} from '@restatedev/restate-sdk';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { BATCH_TOOL_NAME, superJson } from './ai_infra';

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
 * Tool `execute` functions that return a `RestatePromise` (e.g., from
 * `ctx.run()` or `ctx.serviceClient()`) are used directly. Tools that return
 * a plain value or native `Promise` are automatically wrapped in `ctx.run()`
 * for durability.
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
 *     // Already durable — returns RestatePromise directly
 *     myTool: tool({
 *       parameters: z.object({ query: z.string() }),
 *       execute: (input) => ctx.run("myTool", () => doWork(input)),
 *     }),
 *     // Also works — auto-wrapped in ctx.run()
 *     simpleTool: tool({
 *       parameters: z.object({ x: z.number() }),
 *       execute: async (input) => input.x * 2,
 *     }),
 *   }),
 * });
 * ```
 */
export function durableToolCalls<TOOLS extends ToolSet>(
  ctx: Context,
  tools: TOOLS,
): TOOLS & Record<typeof BATCH_TOOL_NAME, ToolSet[string]> {
  return {
    ...tools,
    [BATCH_TOOL_NAME]: createBatchTool(ctx, tools),
  } as TOOLS & Record<typeof BATCH_TOOL_NAME, ToolSet[string]>;
}

// ---------------------------------------------------------------------------
// Internal: Batch Tool
// ---------------------------------------------------------------------------

/**
 * Check if a value is a RestatePromise by looking for Restate-specific methods.
 */
function isRestatePromise(value: unknown): value is RestatePromise<unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    'orTimeout' in value &&
    typeof (value as Record<string, unknown>).orTimeout === 'function'
  );
}

function createBatchTool(ctx: Context, tools: ToolSet): ToolSet[string] {
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

        const result = tool.execute(call.args, {
          ...options,
          toolCallId: call.toolCallId,
        });

        // If the tool already returns a RestatePromise (from ctx.run(),
        // ctx.serviceClient(), etc.), use it directly.
        // Otherwise, wrap in ctx.run() to make it durable.
        if (isRestatePromise(result)) {
          return result;
        }
        return ctx.run(
          `${call.toolName}-tool-execute`,
          async () => result,
          { serde: superJson },
        );
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
