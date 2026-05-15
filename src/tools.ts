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
    description: "Get the loaded ROM name, ROM hash, current frame count, list of available memory domains, and the bridge's capability map (which optional emu/client/savestate/joypad/memory methods this BizHawk build exposes).",
    inputSchema: { type: "object", properties: {} },
  },

  {
    name: "bizhawk_list_memory_domains",
    description: "List the memory domains available on the loaded core (e.g. 'WRAM', 'Cart RAM', 'VRAM', 'System Bus'). Use these names with the `domain` parameter on `bizhawk_read*` / `bizhawk_write*` tools.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "bizhawk_read8",
    description: "Read an unsigned byte from memory. By default reads from the system's main memory; pass `domain` to target a specific named memory domain (use list_memory_domains to discover names).",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer" },
        domain:  { type: "string", description: "Optional memory domain name (default: main memory)" },
      },
    },
  },
  {
    name: "bizhawk_read16",
    description: "Read an unsigned 16-bit little-endian value from memory.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer" },
        domain:  { type: "string" },
      },
    },
  },
  {
    name: "bizhawk_read32",
    description: "Read an unsigned 32-bit little-endian value from memory.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer" },
        domain:  { type: "string" },
      },
    },
  },
  {
    name: "bizhawk_read_range",
    description: "Read a contiguous byte range and return as an integer array. Maximum 4096 bytes per call.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: { type: "integer" },
        length:  { type: "integer", minimum: 1, maximum: 4096 },
        domain:  { type: "string" },
      },
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "bizhawk_write8",
    description: "Write a byte to memory.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer" },
        value:   { type: "integer", minimum: 0, maximum: 255 },
        domain:  { type: "string" },
      },
    },
  },
  {
    name: "bizhawk_write16",
    description: "Write a 16-bit value (LE) to memory.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer" },
        value:   { type: "integer", minimum: 0, maximum: 65535 },
        domain:  { type: "string" },
      },
    },
  },
  {
    name: "bizhawk_write32",
    description: "Write a 32-bit value (LE) to memory.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer" },
        value:   { type: "integer", minimum: 0 },
        domain:  { type: "string" },
      },
    },
  },
  {
    name: "bizhawk_write_range",
    description: "Write a byte sequence to memory. Maximum 4096 bytes per call.",
    inputSchema: {
      type: "object",
      required: ["address", "bytes"],
      properties: {
        address: { type: "integer" },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 4096,
        },
        domain:  { type: "string" },
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
    description: "Pause emulation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_unpause",
    description: "Resume emulation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_frame_advance",
    description: "Step emulation by N frames (default 1). Each call yields the bridge's frame loop, so latency adds up over many frames.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, default: 1 },
      },
    },
  },
  {
    name: "bizhawk_reset",
    description: "Reset the loaded core (equivalent to a hard reset of the emulated console).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_screenshot",
    description: "Save a screenshot to a file. BizHawk's `client.screenshot` requires an explicit path (no temp-file fallback like the other servers).",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path to save the PNG" },
      },
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "bizhawk_save_state",
    description: "Save the emulator state to a file. BizHawk's savestate API is path-based, not slot-based.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path to save the .State file" },
      },
    },
  },
  {
    name: "bizhawk_load_state",
    description: "Load the emulator state from a file. The state must come from the same ROM and BizHawk version.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path to a .State file" },
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
