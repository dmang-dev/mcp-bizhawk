# Super Metroid (Japan, USA) — WRAM address map

Discovered live via `mcp-bizhawk` against BizHawk 2.11.1, May 2026. ROM SHA-1 `DA957F0D63D14CB441D215462904C4FA8519C613`.

All addresses are **offsets into BizHawk's `WRAM` memory domain** — equivalent to SNES bus `$7E:xxxx`. The pure offset is what you pass to `bizhawk_read*` / `bizhawk_write*` tools. Multi-byte values are little-endian (SNES native).

## Samus stats block (verified)

| Offset | Width | Field | Notes |
|---|---|---|---|
| `0x09C2` | u16 | **Current energy (HP)** | **Verified live**: write 50 → HUD ticks 99 → 50 over ~50 frames |
| `0x09C4` | u16 | Max energy | Canonical TAS layout; not yet write-verified |
| `0x09C6` | u16 | Current reserve energy | 0 at game start |
| `0x09C8` | u16 | Max reserve energy | 0 at game start |
| `0x09CA` | u16 | Current missiles | 0 at game start |
| `0x09CC` | u16 | Max missiles | 0 at game start |
| `0x09CE` | u16 | Current super missiles | 0 at game start |
| `0x09D0` | u16 | Max super missiles | 0 at game start |
| `0x09D2` | u16 | Current power bombs | 0 at game start |
| `0x09D4` | u16 | Max power bombs | 0 at game start |

**HP HUD animation gotcha**: writing to current-HP doesn't snap the displayed energy — it ticks by 1/frame from old value toward new (Super Metroid's classic energy-decrement animation). So a `bizhawk_write16(0x09C2, 50)` from HP=99 takes ~50 frames to fully animate. Read the address back to verify the write actually landed; don't rely on visual confirmation alone.

**Ceres prologue caveat**: in the very first room of Ceres Station (the area before the elevator), the HUD displays only ENERGY (no missile/super/power bomb counters), because Samus has no other ammo yet. The stats block is fully populated and writable, but only HP is visible until those counters become non-zero.

## Samus position (verified)

| Offset | Width | Field | Notes |
|---|---|---|---|
| `0x0AF6` | u16 | **Samus X position (pixels)** | **Verified live**: incremented as Samus moved right |
| `0x0AF8` | u16 | Samus X position (sub-pixels) | Fixed-point 0-65535 sub-pixel fraction below `0x0AF6` |
| `0x0AFA` | u16 | Samus Y position (pixels) | Canonical TAS layout |
| `0x0AFC` | u16 | Samus Y position (sub-pixels) | Fixed-point sub-pixel fraction |

Coordinates are **room-local**, NOT world-absolute. They reset each time Samus enters a new room. To track world position, also need room ID (TBD: not yet hunted).

## Recipes

### Find an address from a known on-screen value

```
1. bizhawk_get_info → confirms ROM and active memory domain
2. bizhawk_read_range(0x0900, 1280) → snapshot Samus-state region
3. Cause an action that changes the value (take damage, fire a missile, walk a tile)
4. bizhawk_read_range(0x0900, 1280) → second snapshot
5. Diff snapshots for byte windows where a u16 went from old → new value
6. Verify candidates by writing distinctive values and observing the HUD
```

### Snap-rollback experimentation

```
bizhawk_save_state(path="C:/temp/before.State")
bizhawk_write16(0x09C2, 50)            # drop HP to 50
bizhawk_read16(0x09C2)                 # confirm write landed (immediate)
# observe HUD ticking down for ~50 frames
bizhawk_load_state(path="C:/temp/before.State")  # full rollback
```

### Drive Samus with input

```
# Move RIGHT for 30 frames (interleaved press + advance, NOT press once + advance(30) —
# the latter only holds for the first frame, see bizhawk_press_buttons description)
for i in 1..30:
    bizhawk_press_buttons(buttons={"Right": true})
    bizhawk_frame_advance(count=1)
bizhawk_read16(0x0AF6)                 # check new X
```

## Open hunts

Not yet pinned down — opportunities for follow-up sessions:

- **Room ID** — likely at `0x07BD` (region) and `0x079B` (room within region) per TAS lore. Verify by entering a door and watching which u16 changes.
- **Item bitfield** — which items Samus has equipped (morph ball, bombs, charge beam, etc.). Canonical at `0x09A2`/`0x09A4` (collected/equipped).
- **Game state** — title vs gameplay vs pause vs cutscene. Canonical at `0x0998`.
- **Game timer** — in-game frame counter (excludes pause). Canonical somewhere in the `0x09xx` block.

Each is a 5-minute snapshot-diff hunt with `mcp-bizhawk`, following the recipe above.
