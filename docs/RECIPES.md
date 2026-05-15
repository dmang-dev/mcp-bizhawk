# mcp-bizhawk recipes

Practical examples of driving BizHawk through Claude (or any MCP client). Each recipe is self-contained — copy-paste the prompt at the top of a Claude conversation with `mcp-bizhawk` registered, and Claude will work through the tool calls.

> Prerequisites: BizHawk running with `--socket_ip=127.0.0.1 --socket_port=8766`, ROM loaded, `lua/bridge.lua` open in **Tools → Lua Console**. Sanity-check with `bizhawk_ping` first.

The big BizHawk superpower: **the same tools work across every system its cores cover**. The only thing that changes per platform is the memory-domain name (`WRAM` for SNES vs `RAM` for NES vs `RDRAM` for N64) and the button names. Use `bizhawk_get_info` and `bizhawk_list_memory_domains` to discover both for any loaded ROM.

---

## 1. Find an SNES address from a value you can see on screen

> "I'm playing Super Metroid. Samus has 99 missiles. I want to find which WRAM address holds the missile counter. Fire one missile so it drops to 98, then find the address."

The classic two-snapshot diff. SNES WRAM is 128 KiB so it fits in 32 `read_range` calls of 4096 bytes each — but realistically the missile counter is in the first 8 KiB of game-state RAM, so start there.

```
1. bizhawk_read_range(address=0x0000, length=4096, domain="WRAM")    # snapshot A
2. <user fires a missile>
3. bizhawk_read_range(address=0x0000, length=4096, domain="WRAM")    # snapshot B
4. <Claude diffs A vs B for u8/u16/u32 that went 99 → 98>
```

For Super Metroid specifically, `0x09C6` (WRAM) is the missile counter. The diff approach finds it in seconds with no manual reverse engineering.

---

## 2. Same recipe, different system: NES

> "Mario has 5 lives in SMB1. Lose one, then find the lives counter."

```
1. bizhawk_read_range(address=0x0000, length=2048, domain="RAM")     # NES has 2 KiB RAM
2. <user dies>
3. bizhawk_read_range(address=0x0000, length=2048, domain="RAM")
4. <Claude diffs for byte that went 5 → 4>
```

Same tool calls, different domain name (`RAM` instead of `WRAM`), tiny address space (NES has only 2 KiB system RAM). On Genesis it would be `68K RAM` and 64 KiB, on N64 `RDRAM` and 4–8 MiB. The pattern transfers verbatim.

---

## 3. Inject a value into a known address

> "Give Samus 999 missiles. The address is WRAM 0x09C6 (missile count) and 0x09C8 (missile capacity), both u16-LE."

```
bizhawk_write16(address=0x09C6, value=999, domain="WRAM")
bizhawk_write16(address=0x09C8, value=999, domain="WRAM")
```

Memory writes go straight through BizHawk's memory accessor — there's no MBC / mapper / DMA mediation, so they're appropriate for cheats, debug pokes, and savestate-style seeding, but **not** for emulating cartridge behaviour. Want to seed cart save RAM with proper semantics? Use `bizhawk_load_state` with a pre-prepared state instead.

---

## 4. Verify a write landed

> "I just wrote 0xDEADBEEF to N64 RDRAM address 0x80100000. Confirm."

```
bizhawk_write32(address=0x80100000, value=3735928559, domain="RDRAM")
bizhawk_read32(address=0x80100000, domain="RDRAM")
```

Or use `bizhawk_read_range` for raw bytes and decode endianness manually — useful when you're debugging BizHawk's per-domain endianness conventions (most are little-endian; N64 / older PowerPC stuff can surprise you).

---

## 5. Drive a character with frame-precise input

> "On NES Super Mario Bros: hold Right for 60 frames, then jump (A) for 8 frames, while still holding Right."

BizHawk's `joypad.set` sets state for **one frame** — so to hold a button across N frames you call `bizhawk_press_buttons` and then `bizhawk_frame_advance(count=N)` while it's held, repeating each frame the press needs to remain. The cleanest pattern is to interleave:

```
for _ in 1..60:
    bizhawk_press_buttons(buttons={"Right": true})
    bizhawk_frame_advance(count=1)

for _ in 1..8:
    bizhawk_press_buttons(buttons={"Right": true, "A": true})
    bizhawk_frame_advance(count=1)
```

Per-call latency is ~one frame each (it's how the bridge works), so this is real-time-ish but not faster-than-realtime. For TAS-style frame-perfect input over thousands of frames you'd want BizHawk's native TAStudio instead — this MCP surface is for interactive exploration, not movie creation.

---

## 6. Snapshot → experiment → restore

> "Save state, try this risky write, screenshot the result. If it crashed the game, reload."

```
bizhawk_save_state(path="C:/temp/before.State")
bizhawk_write32(address=0x...., value=0xDEADBEEF, domain="WRAM")
bizhawk_frame_advance(count=10)
bizhawk_screenshot(path="C:/temp/after.png")
# if Claude inspects the screenshot and decides things look bad:
bizhawk_load_state(path="C:/temp/before.State")
```

BizHawk's savestates are path-based (not slot-based like mGBA's). The state file captures the entire emulator state — RAM, registers, mapper state, sound chip state — so reloading is a true rewind.

---

## 7. Walk every memory domain to discover what's interesting

> "What memory domains are available, and how big is each?"

```
1. bizhawk_get_info()                   # overview + framecount + capabilities
2. bizhawk_list_memory_domains()        # array of domain names
3. for each domain:
       bizhawk_read_range(address=0, length=16, domain=name)
                                        # quick sample to see if it has data
```

Useful when you've loaded an unfamiliar ROM and want to understand the memory map before hunting values. Names vary by core: SNES has `WRAM`/`VRAM`/`CARTROM`/`CARTRAM`/`Waterbox PageData`, N64 has `RDRAM`/`SP DMEM`/`SP IMEM`/`PI Reg`/etc., Genesis has `68K RAM`/`Z80 RAM`/`VRAM`/`CARTRAM`.

---

## 8. Cross-system regression test of a homebrew

> "I'm porting my game to NES, Genesis, and GBA. The score variable is at the same logical offset on all three. Verify by writing 12345 and reading back on each."

The Glama-pitch use case: same recipe, swap ROM + domain, no other changes.

```
# NES build loaded:
bizhawk_write16(address=0x0080, value=12345, domain="RAM")
bizhawk_read16 (address=0x0080,              domain="RAM")  # → 12345

# Genesis build loaded:
bizhawk_write16(address=0xFF0080, value=12345, domain="68K RAM")
bizhawk_read16 (address=0xFF0080,              domain="68K RAM")

# GBA build loaded:
bizhawk_write16(address=0x03000080, value=12345, domain="IWRAM")
bizhawk_read16 (address=0x03000080,              domain="IWRAM")
```

Each port runs in its own BizHawk session pointed at this MCP server — restart BizHawk between systems, the bridge picks back up automatically.

---

## Tips for Claude prompts

- **Always start with `bizhawk_get_info`** so Claude knows which system and which memory domains are live before reasoning about addresses.
- **Pass the `domain` parameter explicitly** when you know it — defaults to whichever domain BizHawk currently has selected, which can drift after savestate loads.
- **Snapshot framecount around mutations** so Claude can correlate before/after — `bizhawk_frame_advance(count=N)` returns the new framecount.
- **Memory reads in the first ~30 frames** after a hard reset return mostly zeros — the system hasn't initialized RAM yet. Advance frames or wait for the title screen.
