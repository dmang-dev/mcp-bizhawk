# lua/

Emulator-side scripts that run **inside BizHawk** via Tools → Lua Console →
Open Script.

## Files

- **`bridge.lua`** — polls the `mcp-bizhawk` Node TCP listener once per frame
  (BizHawk's Lua has no native server sockets, only outbound
  `comm.socketServer*`). Each frame: send `READY\n` (or pending `RESULT
  <json>\n`), then receive either `NONE\n` or a JSON command to execute next
  frame. Trade-off: ~1 frame (~16ms at 60Hz) of latency per call.
- **`json.lua`** — vendored pure-Lua JSON encoder/decoder.

## Loading

BizHawk must be launched with socket flags so the Lua client knows where to dial:

```
EmuHawk.exe --socket_ip=127.0.0.1 --socket_port=8766 <rom>
```

Then **Tools → Lua Console → Open Script** → `bridge.lua`. Look for the
`frame loop active` line in BizHawk's Lua console.
