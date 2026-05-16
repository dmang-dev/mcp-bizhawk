# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-05-15

Batched input-playback RPC delivers a 5× wall-clock speedup for multi-frame
input sequences — enabling near-native-speed `.bk2` movie replay through the
bridge instead of a 12-fps stuttery crawl.

### Added

- **`bizhawk_play_input_sequence`** — new MCP tool that takes a `frames`
  array (each element is `{buttons, player}`) and runs `joypad.set +
  emu.frameadvance` per element ENTIRELY SERVER-SIDE in a single bridge
  round-trip. Empirically validated against a 1242-frame Super Metroid
  `.bk2` movie: per-frame mode (looping `press_buttons` +
  `frame_advance(1)` from the client) took 103.3 seconds at 12 fps
  wall-clock; batched mode (one RPC per 200 frames) took **20.9 seconds
  at 59.4 fps** — within 1% of native 60fps emulation speed.
- **`play_input_sequence` Lua handler** in `bridge.lua` — the batch
  driver. Iterates `frames`, calls `joypad.set` then `emu.frameadvance`
  per element, returns `{played, final_framecount}`. Blocks the bridge's
  outer poll loop for the duration of the call (no interleaving with
  other RPCs, no heartbeat), so callers should chunk long sequences
  into batches of ≤200 frames to keep the bridge responsive.
- **`scripts/replay-bk2.cjs` now uses batched mode by default** — chunks
  the parsed input log into 200-frame batches and ships each via
  `play_input_sequence`. The per-batch progress log now reports
  `final_framecount` for verification.

[Unreleased]: https://github.com/dmang-dev/mcp-bizhawk/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.3

## [0.1.2] - 2026-05-15

Bug fixes discovered during a live Super Metroid RAM-hunt session.

### Fixed

- **Orphan process on MCP client restart.** When the MCP client (Claude
  Code, Claude Desktop, etc.) exited, our stdio handshake closed but
  the TCP listener for `bridge.lua` kept the event loop alive — leaving
  an orphaned `node` process bound to port 8766. Every subsequent
  client restart then failed with `EADDRINUSE` until the orphan was
  manually killed. Added shutdown handlers in `src/index.ts` that
  listen for stdin close, `SIGINT`, and `SIGTERM` and call `bh.stop()`
  to release the port.
- **`bizhawk_press_buttons` description was misdocumented.** Previous
  text claimed `press_buttons + frame_advance(count=N)` would hold the
  button for all N frames. Empirically false: BizHawk's `joypad.set`
  is single-frame, so frames 2-N of the advance see no input.
  Confirmed on Super Metroid — a 60-frame advance after one
  `press_buttons(Right)` moved Samus the same +1 pixel as a 10-frame
  advance, proving frames 2-60 had no input held. Rewrote USAGE to
  mandate INTERLEAVED `press_buttons + frame_advance(1)` for
  multi-frame holds.

### Added

- **`docs/SUPER-METROID-ADDRESSES.md`** — WRAM address map for Super
  Metroid (Japan, USA), discovered live via `mcp-bizhawk`. Covers the
  Samus stats block (HP at `0x09C2` verified, missiles/supers/PBs/
  reserves at canonical offsets) and Samus position
  (`0x0AF6`-`0x0AFC`). Includes snapshot-diff hunt recipe and
  snap-rollback experimentation pattern.

## [0.1.1] - 2026-05-15

Tool description quality pass — written to Glama's Tool Definition Quality
Score (TDQS) rubric so every tool maximizes Purpose Clarity, Usage
Guidelines, Behavioral Transparency, Parameter Semantics, Conciseness,
and Contextual Completeness.

### Added

- **`current_memory_domain`** field in `bizhawk_get_info` output — reports
  which domain memory r/w tools default to when `domain` is omitted.
  BizHawk's "current" domain can drift after savestate loads or other
  Lua scripts changing it, so surfacing it explicitly avoids silent
  reads from the wrong address space.

### Changed

- **Every tool description rewritten to the PURPOSE / USAGE / BEHAVIOR /
  RETURNS template** — explicit error conditions ("Returns an error if
  domain is unknown / address out of range / value exceeds max"),
  explicit when-to-use-this-vs-sibling guidance ("for spans use
  bizhawk_read_range — one round-trip vs N frame-latency hops"),
  explicit destructive-behavior notes for every state-mutating tool
  ("DESTRUCTIVE: overwrites with no undo; snapshot via
  bizhawk_save_state first"), and explicit return-value shape.
- **Every parameter now has a `description`** that adds context beyond
  the JSON Schema (alignment requirements, address-space conventions,
  range justifications, units). Domain-parameter and address-parameter
  descriptions are factored into shared constants for consistency.
- **`additionalProperties: false`** added to all tool schemas to fail
  fast on misspelled parameter names.

## [0.1.0] - 2026-05-15

Initial public release.

### Added

- **Lua bridge (`lua/bridge.lua`)** that runs inside BizHawk's Lua Console,
  polling an external TCP server once per frame to ferry commands and replies.
  Runs on BizHawk 2.6.2+.
- **Pure-Lua JSON encode/decode (`lua/json.lua`)** with no external deps.
- **Node.js MCP server (`dist/index.js`)** that hosts the TCP listener
  BizHawk dials into. Inverted transport pattern compared to mGBA-style
  bridges: BizHawk's Lua doesn't have native server sockets, only an
  outbound `comm.socketServer*` client.
- **18 MCP tools**: `bizhawk_ping`, `bizhawk_get_info`,
  `bizhawk_list_memory_domains`, `bizhawk_read8/16/32`,
  `bizhawk_write8/16/32`, `bizhawk_read_range`, `bizhawk_write_range`,
  `bizhawk_press_buttons`, `bizhawk_pause`, `bizhawk_unpause`,
  `bizhawk_frame_advance`, `bizhawk_reset`, `bizhawk_screenshot`,
  `bizhawk_save_state`, `bizhawk_load_state`.
- **Multi-system support**: NES, SNES, GB/GBC/GBA, Sega
  Master System / Genesis / 32X / Saturn, N64, PSX, Atari
  2600/5200/7800, Lynx, ColecoVision, Intellivision, and more — every
  system BizHawk's cores cover. Memory r/w accepts an optional `domain`
  parameter so per-platform memory maps (`WRAM`, `VRAM`, `CARTROM`,
  `68K RAM`, `RDRAM`, `MainRAM`, etc.) are addressable directly.
- **Capabilities map** in `bizhawk_get_info` reports which optional
  emu/client/savestate/joypad/memory methods this BizHawk build exposes,
  so tools can return clean errors instead of `attempt to call a nil value`.
- **Cross-platform install paths**: `npm install -g mcp-bizhawk`,
  `npx -y mcp-bizhawk`, or clone-and-build.
- **GitHub Actions CI** building on Node 18/20/22 across
  Linux/macOS/Windows.
- **Dockerfile + glama.json** for the [Glama MCP registry](https://glama.ai/mcp/servers).

### Worked around (BizHawk Lua API quirks)

- BizHawk's socket server (since 2.6.2) requires **incoming** messages
  to be length-prefixed as `"{length:D} {message}"` — same framing it
  uses for outgoing. Without the prefix, BizHawk's parser silently
  drops the line and `socketServerResponse()` returns empty. The Node
  side now wraps every payload via a `sendFramed()` helper. Documented
  in `Lua/_docs_luacats/comm.d.lua` line 126; missed by us at first
  because our outgoing parser already strips the prefix.
- `comm.socketServerSend(s)` returns a NUMBER (status / bytes sent),
  NOT the server reply. To receive, you must call
  `comm.socketServerResponse()` separately. The bridge does receive
  first (carrying back the previous frame's reply) then send for the
  current frame, decoupling round-trip across a frame boundary.
- BizHawk exposes .NET methods as **userdata** with `__call`
  metamethods, not as plain Lua functions — so capability detection
  has to accept both (`type(v) == "function" or type(v) == "userdata"`).
- `memory.getmemorydomainlist()` returns a 0-indexed Lua table; the
  bridge re-packs into a contiguous 1-indexed array so the JSON
  encoder serializes it as a clean array rather than an object with
  string keys.

[0.1.2]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.2
[0.1.1]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.1
[0.1.0]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.0
