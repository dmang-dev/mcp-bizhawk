#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BizhawkServer } from "./bizhawk.js";
import { registerTools } from "./tools.js";

const HOST = process.env.BIZHAWK_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.BIZHAWK_PORT ?? "8766", 10);

async function main() {
  const bh = new BizhawkServer({ host: HOST, port: PORT });

  // Start the TCP listener immediately. Tool calls will queue up until BizHawk
  // connects (via lua/bridge.lua loaded in BizHawk's Lua Console + the
  // socket server IP/port configured to point here).
  try {
    await bh.start();
    process.stderr.write(
      `[mcp-bizhawk] ${bh.describeTarget()}; waiting for BizHawk to connect...\n` +
      `             1. In BizHawk: Settings > Customize > External Tools (or use --socket_ip / --socket_port flags)\n` +
      `             2. Set socket server target to ${HOST}:${PORT}\n` +
      `             3. Tools > Lua Console > Open Script > select lua/bridge.lua from this repo\n`,
    );
  } catch (err) {
    process.stderr.write(`[mcp-bizhawk] FATAL: could not bind ${HOST}:${PORT}: ${err}\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: "mcp-bizhawk", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, bh);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-bizhawk] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[mcp-bizhawk] fatal: ${err}\n`);
  process.exit(1);
});
