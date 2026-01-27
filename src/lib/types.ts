import { type MCPClient } from '@ai-sdk/mcp';

// Extract types from the MCPClient interface since they're not exported by @ai-sdk/mcp
// These are exported so consumers can use them in their own type annotations

export type ToolSchemas = NonNullable<
  Parameters<MCPClient['tools']>[0]
>['schemas'];

/** @internal Type extraction helpers - do not use directly */
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace _dependencies {
  export function toolSet<T extends ToolSchemas = 'automatic'>(
    client: MCPClient,
  ): ReturnType<typeof client.tools<T>>;
}
export type McpToolSet<T extends ToolSchemas = 'automatic'> = Awaited<
  ReturnType<typeof _dependencies.toolSet<T>>
>;
export type PaginatedRequest = NonNullable<
  Parameters<MCPClient['listResources']>[0]
>;
export type RequestOptions = NonNullable<
  Parameters<MCPClient['listResources']>[0]
>['options'];
export type ListResourcesResult = Awaited<
  ReturnType<MCPClient['listResources']>
>;
export type ReadResourceResult = Awaited<ReturnType<MCPClient['readResource']>>;
export type ListResourceTemplatesResult = Awaited<
  ReturnType<MCPClient['listResourceTemplates']>
>;
export type ListPromptsResult = Awaited<
  ReturnType<MCPClient['experimental_listPrompts']>
>;
export type GetPromptResult = Awaited<
  ReturnType<MCPClient['experimental_getPrompt']>
>;
