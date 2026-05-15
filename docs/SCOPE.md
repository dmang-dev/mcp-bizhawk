# mcp-bizhawk — scope document

Status: planning. No code yet. Companion to mcp-mgba / mcp-pine / mcp-retroarch — same pattern, **inverted transport architecture**, multi-system breadth.

## Premise

[BizHawk](https://github.com/TASEmulators/BizHawk) is the multi-system emulator the TAS (tool-assisted speedrunning) community lives in. It supports — under one roof, with one Lua API — NES, SNES, Game Boy / GBC / GBA, Sega Master System / Genesis / 32X / Saturn, N64, PlayStation 1, Atari 2600 / 5200 / 7800 / Lynx, ColecoVision, Intellivision, ZX Spectrum, Apple II, and more.

A working bridge would unlock cheat hunting, savestate automation, and frame-by-frame game inspection for **all of them simultaneously** through one MCP server. This is the highest-leverage retro-emulator surface remaining after `mcp-retroarch`.

## The architectural twist (vs. mcp-mgba)

mcp-mgba runs a TCP **server** inside mGBA's Lua scripting engine — the bridge waits for connections and replies to them.

BizHawk's Lua doesn't have native sockets. The closest IPC primitive in the `comm` namespace is:

```lua
comm.socketServerSend(s)       -- SEND a string to a configured external server
comm.socketServerResponse()    -- RECEIVE a string back
comm.socketServerSetIp(ip)     -- configure the server address
comm.socketServerSetPort(p)    -- configure the server port
comm.socketServerIsConnected() -- check connection
```

In other words, BizHawk's Lua acts as a **client** to an external server — the architecture is **inverted**:

```
mcp-mgba pattern:
  bridge.lua (server) <─── connects ──── mcp-mgba (client)

mcp-bizhawk pattern:
  mcp-bizhawk (server) ◄── connects ─── bridge.lua (client)
```

The MCP server runs the TCP listener; BizHawk's Lua connects out to it.

## Protocol shape

Each frame, the Lua bridge does roughly:

```lua
event.onframestart(function()
    comm.socketServerSend("READY")
    local cmd = comm.socketServerResponse()
    if cmd and #cmd > 0 then
        local result = dispatch(parse(cmd))
        comm.socketServerSend(encode(result))
    end
end)
```

The MCP server queues commands as MCP tool calls arrive and dispenses one per frame to whatever Lua poll comes in next. Replies are matched by sequence ID.

Trade-off: this is **at least one frame of latency** per command (16ms at 60Hz), vs. mGBA's near-instant request/response. For interactive RAM hunting this is fine; for high-rate-of-fire scripts it matters.

Fallback option: **memory-mapped files** (`comm.mmfRead/Write`) for shared state. Lower per-call latency but trickier semantics. I'd ship the socket version first and only add MMF if the latency ever becomes a real complaint.

## What we'd get from BizHawk's Lua API

BizHawk has a **rich, well-documented** Lua surface — much better than mGBA's. Key namespaces:

- **`memory`** — read/write u8/u16/u32 across any system, with a cleanly-defined "memory domain" concept (system bus / cart RAM / VRAM / etc. as separate addressable spaces)
- **`mainmemory`** — shortcut for the system's main RAM
- **`joypad.set/get`** — structured controller input as a table (e.g. `{A=true, Up=true}`), per-player
- **`emu.frameadvance`** — step one frame
- **`emu.pause`** / **`emu.unpause`**
- **`client.screenshot(path)`** — save PNG
- **`client.reboot_core`** — reset
- **`savestate.save(slot)` / `savestate.load(slot)`** — state I/O
- **`emu.framecount`** — current frame
- **`gameinfo.getromname` / `getromhash`** — game metadata

Compared to mGBA's API:

| Capability | mGBA | BizHawk |
|---|---|---|
| Memory r/w | ✅ (one address space per platform) | ✅ (multiple memory domains, well-named) |
| Bulk read | ✅ `readRange` | ✅ via `memory.read_bytes_as_array` |
| Button input | ✅ raw bitmask | ✅ structured per-button table (cleaner) |
| Screenshot | ✅ | ✅ |
| Pause / frame advance | ⚠️ build-dependent | ✅ always |
| Save/load state | ✅ | ✅ |
| Per-system memory map | ❌ generic | ✅ named domains (e.g. "WRAM", "Cart RAM", "VRAM") |
| Multi-system support | ❌ GBA/GB/GBC | ✅ NES/SNES/GB/GBC/GBA/Genesis/N64/PSX/Saturn/+ |

**No flaky `read32` issues** to work around. BizHawk's Lua API has been TAS-grade stable for over a decade.

## Reusable from mcp-mgba (~70%)

Direct copy with renames:
- `package.json` skeleton (with `bizhawk` keywords)
- `tsconfig.json`
- `.gitignore`
- `LICENSE`
- `.github/workflows/ci.yml`
- README structure
- CHANGELOG skeleton

Adapt:
- `src/index.ts` — same shape, different env vars (`BIZHAWK_HOST`, `BIZHAWK_PORT`)
- `src/tools.ts` — different tool names (`bizhawk_*`), expose memory-domain selector

Rewrite:
- **`src/bizhawk.ts`** — server-side client (listens for Lua bridge connections, queues commands, dispatches replies)
- **`lua/bridge.lua`** — polls our server every frame, executes dispatched commands

## Estimated effort

| Phase | Time |
|---|---|
| Scaffolding (copy mcp-mgba template) | 30 min |
| Server-side TCP queue + per-frame dispatch | 2 h |
| Lua bridge (poll, parse, dispatch, encode) | 2 h |
| Tool layer (memory r/w with domain support, joypad, screenshot, savestate, framecount) | 1.5 h |
| Local testing across 2-3 systems (NES + SNES + N64) | 2 h |
| README, RECIPES, CHANGELOG | 1 h |
| **Total** | **~9 h** |

Risk-adjusted upper bound: **~12 h** if the queue/dispatch logic has ordering surprises or BizHawk's `comm` socket API behaves differently than expected.

## Risks / unknowns

| Risk | Likelihood | Mitigation |
|---|---|---|
| `comm.socketServerSetIp/Port` only configurable via menu, not Lua | Low | Document "set via Tools > Lua" once; not a per-script burden |
| Per-frame poll causes visible perf hit | Low | 16ms idle handshake is negligible at 60fps |
| Multiple players' joypads need per-player addressing | Medium | Use BizHawk's standard `{[1]={A=true}, [2]={B=true}}` shape |
| Memory domain names vary per system | Medium | Add a `bizhawk_list_memory_domains` tool so users can discover them |
| BizHawk's stable Lua bridge across versions | Low | Document tested version in README |

## Open questions for the user

1. **Test setup:** do you have BizHawk installed? Any specific systems you want validated first?
2. **Naming:** `mcp-bizhawk` (matches the project) seems clear. Any objection?
3. **Memory-domain UX:** should `bizhawk_read32` default to "main memory" (`mainmemory.read_u32`) and have a separate `bizhawk_read32_in_domain(domain, addr)` for non-default domains, or accept an optional `domain` parameter in the basic tools?
4. **Same dmang-dev / public / MIT pattern as the others?** (Default: yes)

## Recommendation

**Build it.** BizHawk is the highest-leverage remaining target — one bridge unlocks 10+ systems, with a much cleaner Lua API than mGBA. The only architectural complexity is the inverted transport pattern, which is a one-time learning cost. Once landed, it's the most generally-useful of the four bridges.

After this, the four-server family (`mgba` / `pine` / `retroarch` / `bizhawk`) probably justifies extracting `mcp-emulator-base` for the shared MCP scaffolding.
