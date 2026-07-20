# src/

TypeScript source for the `mcp-bizhawk` MCP server (Node.js). Compiled into
`../dist/` by `tsc` — that's what the published `mcp-bizhawk` bin runs.

## Files

- **`index.ts`** — stdio MCP entrypoint. Reads `BIZHAWK_HOST` /
  `BIZHAWK_PORT`, opens the TCP listener on :8766, registers tools, awaits MCP
  requests on stdio.
- **`bizhawk.ts`** — TCP server accepting one BizHawk client at a time. Frames
  newline-delimited JSON to/from `lua/bridge.lua`. Each MCP call queues a
  command for the next bridge poll.
- **`tools.ts`** — registers every MCP tool against the SDK server. Handles
  the per-system memory-domain story (BizHawk exposes named domains like
  `WRAM`, `EWRAM`, `RDRAM`, `68K RAM` — the tool wrappers default to "current"
  if the caller omits).

## Build

```bash
npm run dev      # tsc --watch
npm run build    # one-shot
```

Output goes to `../dist/index.js`.
