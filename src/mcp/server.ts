import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCheckmarxServer } from './server-core';
import { BridgeClient } from './bridgeClient';

async function main(): Promise<void> {
  const client = new BridgeClient();
  const server = createCheckmarxServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[checkmarx-mcp] server connected over stdio\n');
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`[checkmarx-mcp] uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[checkmarx-mcp] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

void main().catch((error) => {
  process.stderr.write(`[checkmarx-mcp] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});