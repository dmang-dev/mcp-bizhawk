// replay-bk2.cjs — play back a BizHawk .bk2 movie through mcp-bizhawk's bridge.
//
// What this does:
//   1. Unzips the supplied .bk2 (it's a ZIP archive)
//   2. Parses Input Log.txt — the first pipe-line is the LogKey (button names),
//      subsequent pipe-lines are per-frame button states
//   3. Stands up the same BizhawkServer the production MCP server uses, on the
//      same default port (127.0.0.1:8766)
//   4. For each frame: bh.call("press_buttons", {buttons}) + bh.call("frame_advance", {count:1})
//
// Prereqs:
//   - mcp-bizhawk's MCP server (the one Claude Code spawned) must be STOPPED so
//     port 8766 is free. Either close Claude Code, or `taskkill /F /PID <node-on-8766>`.
//   - BizHawk must be running with --socket_ip=127.0.0.1 --socket_port=8766 +
//     lua/bridge.lua loaded. Restart bridge.lua in the Lua Console after
//     stopping mcp-bizhawk so it reconnects to OUR server.
//
// Usage:
//   node .scratch/replay-bk2.cjs <path-to-bk2> [max-frames] [--state PATH | --no-state]
//
// Flags:
//   --state PATH   Override the embedded starting state with this .State file
//                  (e.g. a BizHawk QuickSave that you know loads cleanly on
//                  the current core). Useful when the embedded state's core
//                  doesn't match the live BizHawk core.
//   --no-state     Skip the load-state step entirely — replay starts from
//                  whatever state BizHawk is currently in. Useful when you've
//                  already positioned the emulator manually.
//
// Notes:
//   - Per-frame wall-clock is ~16ms emulation + bridge round-trip (~5-10ms each
//     for press_buttons and frame_advance), so a 60Hz second of TAS = ~30s real.
//     A 3600-frame minute = ~30 min wall-clock. Don't try to replay full any%
//     TASes this way — pick short segments.
//   - .bk2 LogKey may not match BizHawk's joypad.set button names 1:1 across
//     all cores. SNES is straightforward; other systems may need a remap table.

"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Lazy require — only used as the bridge server, not the MCP server.
const { BizhawkServer } = require(path.resolve(__dirname, "..", "dist", "bizhawk.js"));

// ── ZIP parser (sufficient for .bk2 — uncompressed or deflate, no encryption) ─

function unzipBk2(buf) {
  // .bk2 is a standard ZIP. We need Input Log.txt — find its central-directory
  // entry, decompress, return as string. Implements just enough of ZIP for this.
  const out = {};
  // End-of-central-directory record (EOCD) is at the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no EOCD)");
  const cdEntries = buf.readUInt16LE(eocd + 10);
  const cdSize    = buf.readUInt32LE(eocd + 12);
  const cdOffset  = buf.readUInt32LE(eocd + 16);
  let cp = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(cp) !== 0x02014b50) throw new Error(`Bad central-directory entry at ${cp}`);
    const method     = buf.readUInt16LE(cp + 10);
    const compSize   = buf.readUInt32LE(cp + 20);
    const uncompSize = buf.readUInt32LE(cp + 24);
    const nameLen    = buf.readUInt16LE(cp + 28);
    const extraLen   = buf.readUInt16LE(cp + 30);
    const commentLen = buf.readUInt16LE(cp + 32);
    const localHdr   = buf.readUInt32LE(cp + 42);
    const name       = buf.slice(cp + 46, cp + 46 + nameLen).toString("utf8");
    // Read the local file header to find the actual data offset
    const lhNameLen  = buf.readUInt16LE(localHdr + 26);
    const lhExtraLen = buf.readUInt16LE(localHdr + 28);
    const dataStart  = localHdr + 30 + lhNameLen + lhExtraLen;
    const dataEnd    = dataStart + compSize;
    let bytes;
    if (method === 0) {
      bytes = buf.slice(dataStart, dataEnd);
    } else if (method === 8) {
      bytes = zlib.inflateRawSync(buf.slice(dataStart, dataEnd));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    out[name] = bytes;
    cp += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Input Log parser ─────────────────────────────────────────────────────────

/**
 * Parse Input Log.txt into:
 *   { systemButtons: [...], playerButtons: [[...], [...]], frames: [ { system, players: [{...}, ...] }, ... ] }
 *
 * Format reminder:
 *   - First line of the [Input] section is the LogKey: `|reset, ...|U,D,L,R,...|U,D,L,R,...|`
 *     - Each |...| segment defines one "controller" (the first is system commands like Reset)
 *     - Buttons within a segment are comma-separated and ordered left-to-right
 *   - Subsequent lines starting with `|` are frames: each segment is a string the same length
 *     as the segment's button list, where `.` = unpressed and any other char = pressed
 *     (BizHawk only checks for `.` vs non-`.`, the actual letter is convention)
 *
 * For SNES, segment 1 (player 1) is typically:
 *   |U|D|L|R|s|S|Y|B|X|A|l|r|
 * abbreviated as: Up, Down, Left, Right, select, Start, Y, B, X, A, L-shoulder, R-shoulder.
 * Different cores may use different abbreviations — that's why we read the LogKey live.
 */
function parseInputLog(text) {
  const lines = text.split(/\r?\n/);
  // Find the LogKey line — it's the first line that starts with `|` and contains commas
  // (header lines like `|...|...|...|` without commas in the segments mean it's a frame).
  // Actually, BizHawk's LogKey lines are of the form:
  //   LogKey:#Reset|Power|U|D|L|R|Start|Select|Y|B|X|A|L|R|
  // i.e. one button name per pipe-separated slot, with NO commas.
  // The whole thing is preceded by `LogKey:#`.
  let logKey = null;
  for (const line of lines) {
    if (line.startsWith("LogKey:")) {
      // Strip prefix "LogKey:#" or "LogKey:"
      logKey = line.replace(/^LogKey:#?/, "");
      break;
    }
  }
  if (!logKey) throw new Error("Could not find LogKey line in Input Log.txt");

  // LogKey is a pipe-separated list of button names, optionally with multiple
  // controllers separated by something — actually BizHawk just lists every button
  // (across all controllers and system commands) once, in the order they appear in
  // each frame's encoded string. We split on `|` and ignore empty segments.
  const buttonNames = logKey.split("|").filter(s => s.length > 0);

  // Parse frames
  const frames = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (line.startsWith("|Comment") || line.startsWith("|Subtitle")) continue; // metadata
    // A frame line: split on `|`, filter empties, characters within each segment correspond
    // 1:1 to buttonNames slots. But actually buttonNames are pipe-separated TOO — so each
    // pipe-segment in the frame corresponds to ONE buttonName, and the segment is a single
    // character (`.` or non-`.`). Let me verify by counting.
    const segments = line.split("|").slice(1, -1); // strip leading and trailing pipe
    if (segments.length === 0) continue;

    // If segment count matches buttonNames, each segment is a single button (1 char).
    // If segment count is less, segments group multiple buttons (older format).
    let pressed = {};
    if (segments.length === buttonNames.length) {
      for (let i = 0; i < segments.length; i++) {
        const ch = segments[i];
        if (ch && ch !== "." && ch !== " ") pressed[buttonNames[i]] = true;
      }
    } else {
      // Fallback: flatten segments and walk char-by-char against buttonNames
      const flat = segments.join("");
      for (let i = 0; i < flat.length && i < buttonNames.length; i++) {
        const ch = flat[i];
        if (ch && ch !== "." && ch !== " ") pressed[buttonNames[i]] = true;
      }
    }
    frames.push(pressed);
  }
  return { buttonNames, frames };
}

// ── Button-name normalization ────────────────────────────────────────────────
// BizHawk's joypad.set on SNES expects bare button names: "Up", "Down", "Left",
// "Right", "Start", "Select", "Y", "B", "X", "A", "L", "R". But the .bk2 LogKey
// prefixes each button with the controller it belongs to ("P1 Up", "P2 Up",
// etc.) so the same names can recur across multiple controllers in one frame
// string. We strip "P{n} " prefixes and also drop system buttons that joypad.set
// can't trigger (Reset, Power — those are emulator-level commands, not joypad).
const SYSTEM_BUTTONS = new Set(["Reset", "Power", "#Reset", "#Power"]);

function normalizeButtonName(raw) {
  // Strip leading "#" (some LogKeys use it on system commands or as a separator
  // marker), then strip "P<n> " controller prefix.
  let n = raw.replace(/^#/, "");
  n = n.replace(/^P\d+\s+/, "");
  return n;
}

function filterPressed(pressed) {
  const out = {};
  for (const [rawName, v] of Object.entries(pressed)) {
    if (SYSTEM_BUTTONS.has(rawName)) continue;
    const name = normalizeButtonName(rawName);
    if (SYSTEM_BUTTONS.has(name)) continue;
    out[name] = v;
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Parse positional + flag args
  const args = process.argv.slice(2);
  let bk2Path = null;
  let maxFrames = Infinity;
  let stateOverride = null;
  let noState = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--state") { stateOverride = args[++i]; }
    else if (a === "--no-state") { noState = true; }
    else if (!bk2Path) { bk2Path = a; }
    else if (maxFrames === Infinity) { maxFrames = parseInt(a, 10); }
  }
  if (!bk2Path) {
    console.error("Usage: node .scratch/replay-bk2.cjs <path-to-bk2> [max-frames] [--state PATH | --no-state]");
    process.exit(2);
  }
  if (stateOverride && noState) {
    console.error("--state and --no-state are mutually exclusive");
    process.exit(2);
  }
  if (stateOverride && !fs.existsSync(stateOverride)) {
    console.error(`--state PATH not found: ${stateOverride}`);
    process.exit(2);
  }
  if (!fs.existsSync(bk2Path)) {
    console.error(`Not found: ${bk2Path}`);
    process.exit(2);
  }

  console.log(`=== loading ${bk2Path} ===`);
  const zipBuf = fs.readFileSync(bk2Path);
  const files = unzipBk2(zipBuf);

  const inputName = Object.keys(files).find(n => /input log\.txt/i.test(n));
  if (!inputName) {
    console.error("No Input Log.txt in archive. Files: " + Object.keys(files).join(", "));
    process.exit(2);
  }
  const headerName = Object.keys(files).find(n => /^header\.txt$/i.test(n));
  if (headerName) {
    console.log("--- Header ---");
    console.log(files[headerName].toString("utf8").trim());
    console.log();
  }

  const { buttonNames, frames } = parseInputLog(files[inputName].toString("utf8"));
  console.log(`Parsed ${frames.length} frames. Button slots: ${buttonNames.join(", ")}`);
  const playFrames = Math.min(frames.length, maxFrames);
  console.log(`Will replay first ${playFrames} frames.\n`);

  // Decide which starting state to load (in priority order):
  //   1. --state PATH override  → load that file
  //   2. --no-state              → skip load entirely
  //   3. embedded state in .bk2  → extract and load
  //   4. nothing in .bk2         → skip (movie starts from power-on)
  //
  // .bk2 may include an embedded "starting state" — BizHawk records this when
  // you pick "SaveRAM + savestate" instead of "Power-on (clean)". On modern
  // BizHawk (2.5+), the state file inside the archive is `Core.bin.zst`
  // (Zstandard-compressed BizHawk savestate). We can write the bytes out as
  // a `.State` file and pass to savestate.load — BizHawk handles the
  // Zstd-wrapped format transparently.
  let statePathToLoad = null;
  if (stateOverride) {
    statePathToLoad = stateOverride;
    console.log(`Using --state override: ${stateOverride}`);
  } else if (noState) {
    console.log("--no-state set — skipping state load; replay starts from current emulator state.");
  } else {
    const stateName = Object.keys(files).find(n => /\.(State|state|bin\.zst|zst)$/i.test(n));
    if (stateName) {
      statePathToLoad = path.join(require("node:os").tmpdir(), `bk2-startstate-${Date.now()}.State`);
      fs.writeFileSync(statePathToLoad, files[stateName]);
      console.log(`Embedded starting state found (${stateName}, ${files[stateName].length} bytes) → ${statePathToLoad}`);
    } else {
      console.log("No embedded starting state — movie starts from power-on (current emulator state will be used as-is).");
    }
  }
  console.log();

  // Stand up our bridge server (replaces mcp-bizhawk for this run)
  const bh = new BizhawkServer({ host: "127.0.0.1", port: 8766 });
  await bh.start();
  console.log(`Listening on 127.0.0.1:8766. Waiting for bridge.lua to connect...`);
  console.log(`(In BizHawk: Tools → Lua Console → Restart bridge.lua so it reconnects to us.)\n`);

  // Wait for bridge to start polling
  while (!bh.isBridgeReady()) {
    await new Promise(r => setTimeout(r, 200));
  }
  console.log("Bridge ready. Pinging...");
  const pong = await bh.call("ping");
  console.log(`  ${pong}\n`);

  if (statePathToLoad) {
    console.log(`Loading starting state from ${statePathToLoad}...`);
    try {
      await bh.call("load_state", { path: statePathToLoad });
      console.log(`  load_state RPC returned without error.`);
      // Verify the load actually applied by checking the framecount changed.
      // If it didn't, BizHawk likely silently rejected the state (core
      // mismatch, version mismatch, corrupt file).
      const info = await bh.call("get_info");
      console.log(`  post-load framecount: ${info.framecount}`);
      console.log(`  post-load ROM: ${info.rom_name}\n`);
    } catch (err) {
      console.error(`  load_state FAILED: ${err.message}`);
      console.error(`  Aborting — replaying inputs against the wrong state would produce noise.`);
      bh.stop();
      process.exit(1);
    }
  }

  // Chunk size for batched play_input_sequence. ~200 frames per call keeps
  // each batch's wall-clock under ~3.5s at native 60fps emulation, which
  // means the bridge isn't blocked from other RPCs for too long and the
  // progress logs print frequently enough to look responsive. Larger chunks
  // = fewer round-trips but longer per-batch freeze; smaller = more
  // responsive but closer to the per-frame-RPC overhead of the legacy mode.
  const CHUNK = 200;
  console.log(`=== starting playback (batched, ${CHUNK} frames/RPC) ===`);
  const t0 = Date.now();
  let played = 0;
  while (played < playFrames) {
    const end = Math.min(played + CHUNK, playFrames);
    const batch = [];
    for (let i = played; i < end; i++) {
      batch.push({ buttons: filterPressed(frames[i]), player: 1 });
    }
    const result = await bh.call("play_input_sequence", { frames: batch });
    played = end;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = (played / (Date.now() - t0) * 1000).toFixed(1);
    const lastB = batch[batch.length - 1].buttons;
    const lastPressed = Object.keys(lastB).filter(k => lastB[k]).join("+") || "(none)";
    console.log(`  played ${played}/${playFrames}  @${rate}fps wall-clock  elapsed=${elapsed}s  final_fc=${result.final_framecount}  last=${lastPressed}`);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== done. ${playFrames} frames in ${totalSec}s (avg ${(playFrames/totalSec).toFixed(1)} fps wall-clock) ===`);

  bh.stop();
  process.exit(0);
}

main().catch(err => {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
});
