import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { BizhawkServer } from "./bizhawk.js";

const VALID_BUTTONS = [
  "A", "B", "X", "Y",                 // Face buttons
  "Up", "Down", "Left", "Right",      // D-pad
  "Start", "Select",                  // System
  "L", "R", "L1", "R1", "L2", "R2", "L3", "R3", // Shoulders/triggers/sticks
  "C", "Z", "C-Up", "C-Down", "C-Left", "C-Right",  // N64
  "Mode",                             // Genesis 6-button
  // Different systems use different names — pass whatever your platform uses.
  // If unsure, run a probe with `bizhawk_press_buttons {"A":true}` and
  // observe the active core's input log in BizHawk.
];

const TOOLS: Tool[] = [
  {
    name: "bizhawk_ping",
    description: "Verify the BizHawk Lua bridge is connected. Returns 'pong' on success.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_get_info",
    description: "Get the loaded ROM name, ROM hash, current frame count, list of available memory domains, the active (default) memory domain used when `domain` is omitted on read/write tool calls, and the bridge's capability map (which optional emu/client/savestate/joypad/memory methods this BizHawk build exposes).",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "bizhawk_list_memory_domains",
    description: "List the memory domains available on the loaded core (e.g. 'WRAM', 'Cart RAM', 'VRAM', 'System Bus'). Use these names with the `domain` parameter on `bizhawk_read*` / `bizhawk_write*` tools.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────
  //
  // All memory r/w tools read/write the underlying emulator memory directly —
  // they bypass the cartridge bus model (no MBC/mapper paging, no DMA), so
  // they're appropriate for cheats, debug pokes, and game-state inspection,
  // but NOT for emulating cartridge behaviour. To seed cart save RAM with
  // proper semantics, use bizhawk_load_state with a pre-prepared state file.

  {
    name: "bizhawk_read8",
    description: "Read an unsigned 8-bit byte from emulator memory at the given address. Returns the value formatted as decimal and hex (e.g. \"0x09C6: 99 (0x63)\"). By default reads from BizHawk's currently selected memory domain (see bizhawk_get_info for which one); pass `domain` to target a specific named memory domain. Use bizhawk_list_memory_domains to discover names — they vary per system (WRAM on SNES, RAM on NES, RDRAM on N64, 68K RAM on Genesis, MainRAM on PSX, EWRAM/IWRAM on GBA).",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain. Domain offsets are 0-based and per-domain (NOT system bus addresses) — e.g. SNES WRAM 0x09C6 not 0x7E09C6." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain. Discover names with bizhawk_list_memory_domains." },
      },
    },
  },
  {
    name: "bizhawk_read16",
    description: "Read an unsigned 16-bit little-endian value from emulator memory at the given address. Returns the value formatted as decimal and hex. By default reads from BizHawk's currently selected memory domain; pass `domain` to target a specific one. For values stored big-endian on the original hardware (some N64/PSX/Saturn fields), read with bizhawk_read_range and decode manually — this tool always interprets bytes as little-endian.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain. Reads two consecutive bytes starting here." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain. Discover with bizhawk_list_memory_domains." },
      },
    },
  },
  {
    name: "bizhawk_read32",
    description: "Read an unsigned 32-bit little-endian value from emulator memory at the given address. Returns the value formatted as decimal and hex. By default reads from BizHawk's currently selected memory domain; pass `domain` to target a specific one. For big-endian fields or non-aligned multi-word reads, prefer bizhawk_read_range and decode the bytes yourself.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain. Reads four consecutive bytes starting here." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain. Discover with bizhawk_list_memory_domains." },
      },
    },
  },
  {
    name: "bizhawk_read_range",
    description: "Read a contiguous byte range and return as an integer array (one element per byte, 0-255). Use this instead of multiple bizhawk_read8 calls when you need more than a few bytes — it's a single round-trip vs N frame-latency hops. Maximum 4096 bytes per call (BizHawk's per-call serialization limit). For larger reads, batch in 4 KiB chunks. Useful for two-snapshot memory diffs (RAM-hunt workflow): grab a window before and after a known change, then look for the values that match the delta.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Starting byte offset within the chosen memory domain." },
        length:  { type: "integer", minimum: 1, maximum: 4096, description: "Number of consecutive bytes to read (1-4096)." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain." },
      },
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "bizhawk_write8",
    description: "Write a single unsigned byte (0-255) to emulator memory at the given address. The write goes through BizHawk's memory accessor — direct, immediate, with no bus mediation (no MBC bank-switch trigger, no cartridge mapper side-effects, no DMA). Appropriate for cheats and debug pokes; NOT appropriate for emulating cartridge behaviour. To seed cart save RAM realistically, use bizhawk_load_state with a pre-prepared .State file. Returns confirmation with the address and value.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain to write to." },
        value:   { type: "integer", minimum: 0, maximum: 255, description: "Byte value to write (0-255 / 0x00-0xFF)." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain. Discover with bizhawk_list_memory_domains." },
      },
    },
  },
  {
    name: "bizhawk_write16",
    description: "Write an unsigned 16-bit little-endian value to emulator memory at the given address. Writes two consecutive bytes (low byte first). Direct memory write — no MBC/mapper/DMA mediation, see bizhawk_write8 notes. To write a big-endian 16-bit value, swap the bytes yourself and use bizhawk_write_range. Returns confirmation with the address and value.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain. The low byte lands here, high byte at address+1." },
        value:   { type: "integer", minimum: 0, maximum: 65535, description: "16-bit value to write (0-65535 / 0x0000-0xFFFF)." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain." },
      },
    },
  },
  {
    name: "bizhawk_write32",
    description: "Write an unsigned 32-bit little-endian value to emulator memory at the given address. Writes four consecutive bytes (least-significant byte first). Direct memory write — no MBC/mapper/DMA mediation, see bizhawk_write8 notes. For big-endian layouts use bizhawk_write_range and pre-byteswap. Returns confirmation with the address and value.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain. LSB lands here, MSB at address+3." },
        value:   { type: "integer", minimum: 0, maximum: 4294967295, description: "32-bit value to write (0-4294967295 / 0x00000000-0xFFFFFFFF)." },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain." },
      },
    },
  },
  {
    name: "bizhawk_write_range",
    description: "Write a contiguous byte sequence to emulator memory starting at the given address. Use instead of multiple bizhawk_write8 calls when seeding more than a few bytes — single round-trip vs N frame-latency hops. Maximum 4096 bytes per call (BizHawk serialization limit). Useful for installing cheat tables, patching code blocks, or restoring a captured byte window after experiments. Direct memory write — no MBC/mapper/DMA mediation. Returns the count of bytes written.",
    inputSchema: {
      type: "object",
      required: ["address", "bytes"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Starting byte offset within the chosen memory domain. Bytes are written sequentially from here." },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 4096,
          description: "Byte values to write, one per element (each 0-255). Length 1-4096.",
        },
        domain:  { type: "string", description: "Optional memory domain name (case-sensitive). Omit to use BizHawk's currently selected domain." },
      },
    },
  },

  // ── Input ───────────────────────────────────────────────────────────────

  {
    name: "bizhawk_press_buttons",
    description: `Set the joypad state for one player. \`buttons\` is an object where keys are button names and values are booleans (true=pressed, false=released). The state is set for ONE frame and then BizHawk's input handling moves on. To hold a button across multiple frames, call this each frame with the same buttons set true.\n\nButton names vary per system. Common names: ${VALID_BUTTONS.join(", ")}. Use whatever names the active core understands.`,
    inputSchema: {
      type: "object",
      required: ["buttons"],
      properties: {
        buttons: {
          type: "object",
          description: "Map of button name → pressed (boolean). Example: {\"A\": true, \"Up\": true}",
          additionalProperties: { type: "boolean" },
        },
        player: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "Player number (1-based). Default 1.",
        },
      },
    },
  },

  // ── Emulator control ───────────────────────────────────────────────────

  {
    name: "bizhawk_pause",
    description: "Pause emulation. The current frame stays on screen and game-logic clocks freeze, but the BizHawk Lua bridge keeps polling — so subsequent memory r/w and other tool calls still work while paused. Use bizhawk_unpause to resume, or bizhawk_frame_advance to step one frame at a time without leaving pause. Some BizHawk cores don't expose pause via the Lua API; check `capabilities.pause` in bizhawk_get_info first if you need to handle that case gracefully.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_unpause",
    description: "Resume emulation after a pause. Counterpart to bizhawk_pause. Some BizHawk cores don't expose unpause via the Lua API; check `capabilities.unpause` in bizhawk_get_info first if you need to handle that case gracefully.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_frame_advance",
    description: "Step emulation by exactly N frames (default 1) and return the new framecount. Useful for frame-precise input automation, animation inspection, or letting the system initialize after a hard reset (RAM is mostly zero in the first ~30 frames). Each step costs roughly one real frame (~16ms at 60Hz) plus one bridge round-trip — so advancing 600 frames takes ~10 seconds wall-clock. For long jumps, prefer bizhawk_save_state / bizhawk_load_state of a pre-prepared state. Works whether emulation is currently paused or running.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, default: 1, description: "Number of frames to advance (≥1, default 1). Returned framecount = previous framecount + count." },
      },
    },
  },
  {
    name: "bizhawk_reset",
    description: "Reset the loaded core — equivalent to a hard reset of the emulated console (power cycle), not a soft NMI/IRQ. RAM contents become indeterminate (typically zeroed), the CPU returns to the reset vector, and the framecount is reset. The loaded ROM stays loaded; only volatile state is cleared. Use bizhawk_load_state instead if you want to return to a specific known good point. Some cores don't expose this via the Lua API; check `capabilities.reboot_core` in bizhawk_get_info first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_screenshot",
    description: "Save a PNG screenshot of the current emulator display to a file path. BizHawk's `client.screenshot` requires an explicit absolute path (no temp-file fallback). The image captures whatever the emulator is currently rendering — if you want a screenshot of a specific game state, pause / advance frames / load state first to get the frame you want, then call this. Returns the path written.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute filesystem path to write the PNG to (e.g. C:/temp/snap.png on Windows, /tmp/snap.png on Linux/macOS). Parent directory must exist. File is overwritten if present." },
      },
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "bizhawk_save_state",
    description: "Save the entire emulator state to a file at the given path. State files capture RAM, CPU/PPU/APU registers, mapper state, sound chip state, and timing — a true point-in-time snapshot that bizhawk_load_state can perfectly restore. BizHawk's savestate API is path-based (NOT slot-based like mGBA's). Returns the path written. Compatible only with the exact same ROM and BizHawk core version that produced it.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute filesystem path to write the .State file to (extension is convention, not required). Parent directory must exist. File is overwritten if present." },
      },
    },
  },
  {
    name: "bizhawk_load_state",
    description: "Restore the emulator from a previously saved .State file at the given path. Counterpart to bizhawk_save_state. The state file must come from the same ROM and same BizHawk core version that produced it — loading an incompatible state usually crashes the core. Useful for snapshot/experiment/restore workflows: save before a risky write, do the experiment, load to undo. Returns the path loaded.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute filesystem path to an existing .State file produced by bizhawk_save_state on this same ROM and BizHawk core version." },
      },
    },
  },
];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fmtHex(n: unknown): string {
  if (typeof n !== "number") return String(n);
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}
function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function registerTools(server: Server, bh: BizhawkServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;
    const a = () => p.address as number;
    const dom = () => p.domain ? { domain: p.domain } : {};

    switch (name) {
      case "bizhawk_ping": {
        const r = await bh.call<string>("ping");
        return ok(r);
      }

      case "bizhawk_get_info": {
        const r = await bh.call<{
          rom_name?: string;
          rom_hash?: string;
          framecount?: number;
          memory_domains?: string[];
          current_memory_domain?: string;
          capabilities?: Record<string, boolean>;
        }>("get_info");
        const lines = [
          `ROM:        ${r.rom_name ?? "(unavailable)"}`,
          `ROM hash:   ${r.rom_hash ?? "(unavailable)"}`,
          `Framecount: ${r.framecount ?? "(unavailable)"}`,
        ];
        if (r.memory_domains?.length) {
          lines.push("");
          lines.push(`Memory domains: ${r.memory_domains.join(", ")}`);
          if (r.current_memory_domain) {
            lines.push(`Active domain (used when 'domain' is omitted): ${r.current_memory_domain}`);
          }
        }
        if (r.capabilities) {
          const missing = Object.entries(r.capabilities).filter(([, v]) => !v).map(([k]) => k);
          if (missing.length) {
            lines.push("");
            lines.push(`Missing capabilities on this BizHawk build: ${missing.join(", ")}`);
          }
        }
        return ok(lines.join("\n"));
      }

      case "bizhawk_list_memory_domains": {
        const r = await bh.call<string[]>("list_memory_domains");
        return ok("Memory domains:\n  " + r.join("\n  "));
      }

      case "bizhawk_read8":  return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read8", { address: a(), ...dom() }))}`);
      case "bizhawk_read16": return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read16", { address: a(), ...dom() }))}`);
      case "bizhawk_read32": return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read32", { address: a(), ...dom() }))}`);

      case "bizhawk_read_range": {
        const bytes = await bh.call<number[]>("read_range", { address: a(), length: p.length, ...dom() });
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        return ok(`${addrHex(a())} [${bytes.length} bytes${p.domain ? `, ${p.domain}` : ""}]:\n${hex}`);
      }

      case "bizhawk_write8": {
        await bh.call("write8", { address: a(), value: p.value, ...dom() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write16": {
        await bh.call("write16", { address: a(), value: p.value, ...dom() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write32": {
        await bh.call("write32", { address: a(), value: p.value, ...dom() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write_range": {
        const r = await bh.call<{ written: number }>("write_range", { address: a(), bytes: p.bytes, ...dom() });
        return ok(`Wrote ${r.written} bytes → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }

      case "bizhawk_press_buttons": {
        await bh.call("press_buttons", { buttons: p.buttons, player: p.player ?? 1 });
        const pressed = Object.entries(p.buttons as Record<string, boolean>)
          .filter(([, v]) => v).map(([k]) => k);
        return ok(`Set joypad ${p.player ?? 1}: ${pressed.length ? pressed.join("+") : "(all released)"}`);
      }

      case "bizhawk_pause":         await bh.call("pause");          return ok("Emulation paused");
      case "bizhawk_unpause":       await bh.call("unpause");        return ok("Emulation resumed");
      case "bizhawk_reset":         await bh.call("reset");          return ok("Core reset");
      case "bizhawk_frame_advance": {
        const f = await bh.call<number>("frame_advance", { count: p.count ?? 1 });
        return ok(`Advanced ${p.count ?? 1} frame(s). Framecount: ${f}`);
      }

      case "bizhawk_screenshot": {
        const path = await bh.call<string>("screenshot", { path: p.path });
        return ok(`Screenshot saved: ${path}`);
      }

      case "bizhawk_save_state": {
        const r = await bh.call<{ path: string }>("save_state", { path: p.path });
        return ok(`Saved state to ${r.path}`);
      }
      case "bizhawk_load_state": {
        const r = await bh.call<{ path: string }>("load_state", { path: p.path });
        return ok(`Loaded state from ${r.path}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}
