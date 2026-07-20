# scripts/

Utility scripts for development and verification.

## Files

- **`replay-bk2.cjs`** — replays a BizHawk movie file (`.bk2`) through the
  bridge. Useful for regression testing memory r/w timing against a known
  good run.

## Usage

Run directly via Node:

```bash
node scripts/replay-bk2.cjs <path/to/movie.bk2>
```

Requires a running BizHawk with the matching ROM loaded and `bridge.lua` active.
