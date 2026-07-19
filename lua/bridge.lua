-- bridge.lua: BizHawk-side polling client for mcp-bizhawk
--
-- Architecture (inverted from mcp-mgba):
--
--   mcp-bizhawk (Node.js, runs the TCP server)
--          ▲
--          │  TCP — newline-delimited JSON
--          │
--   bridge.lua (BizHawk Lua, polls every frame)
--
-- Each frame, this script does ONE round-trip with the external server:
--   1. Lua sends "READY\n"  (or "RESULT <json>\n" if there's a pending result)
--   2. Server responds with EITHER "NONE\n" OR a JSON command "{id,method,params}\n"
--   3. If a command came back, execute it locally and stash the result so
--      the next frame's send carries it back.
--
-- Wire format: newline-delimited UTF-8.
--   - Lua → server: "READY\n" | "RESULT <json>\n"
--   - Server → Lua: "NONE\n"  | "<json command>\n"
--
-- Setup in BizHawk:
--   1. Tools → External Tool → Lua Console
--   2. Settings → Customize → External Tools → "Custom Tools" — set socket
--      server IP/port to 127.0.0.1:8766 (or however you launched mcp-bizhawk)
--      OR launch BizHawk with --socket_ip=127.0.0.1 --socket_port=8766
--   3. Tools → Lua Console → Open this script
--
-- Verify with `mcp-bizhawk` startup log: should print "BizHawk client connected".

local json = require("json")

-- Pending result from last frame's command. Sent back at the start of the
-- next frame's round-trip (instead of a bare "READY").
local pending_result = nil

-- ── Capability detection ────────────────────────────────────────────────────
-- BizHawk's Lua API is largely stable but a few of the higher-level helpers
-- vary by build. Probe at startup so we can return clean errors instead of
-- "attempt to call a nil value" if something's missing.
--
-- IMPORTANT: BizHawk exposes .NET methods to Lua as USERDATA with __call
-- metamethods, not as plain Lua functions. Accept either.
local function has(t, name)
    if not t then return false end
    local v = rawget(t, name)
    if v == nil then v = t[name] end  -- fallback for proxy tables
    if v == nil then return false end
    local tv = type(v)
    return tv == "function" or tv == "userdata"
end

local CAPS = {
    -- emu
    framecount   = emu and has(emu, "framecount"),
    pause        = emu and has(emu, "pause"),
    unpause      = emu and has(emu, "unpause"),
    frameadvance = emu and has(emu, "frameadvance"),
    -- client
    reboot_core  = client and has(client, "reboot_core"),
    screenshot   = client and has(client, "screenshot"),
    -- savestate
    savestate_save = savestate and has(savestate, "save"),
    savestate_load = savestate and has(savestate, "load"),
    -- joypad
    joypad_set = joypad and has(joypad, "set"),
    joypad_get = joypad and has(joypad, "get"),
    -- memory
    memory_read_u8     = memory and has(memory, "read_u8"),
    memory_read_u16_le = memory and has(memory, "read_u16_le"),
    memory_read_u32_le = memory and has(memory, "read_u32_le"),
    memory_write_u8    = memory and has(memory, "write_u8"),
    memory_write_u16_le = memory and has(memory, "write_u16_le"),
    memory_write_u32_le = memory and has(memory, "write_u32_le"),
    memory_get_memorydomain_list   = memory and has(memory, "getmemorydomainlist"),
    memory_get_current_memorydomain = memory and has(memory, "getcurrentmemorydomain"),
    memory_use_memory_domain       = memory and has(memory, "usememorydomain"),
    memory_get_memorydomainsize    = memory and has(memory, "getmemorydomainsize"),
    -- bulk readers (vary by build) — used to make memory search fast; we fall
    -- back to a read_u8 loop when neither is present.
    memory_read_bytes_as_array     = memory and has(memory, "read_bytes_as_array"),
    memory_readbyterange           = memory and has(memory, "readbyterange"),
    -- mainmemory (subset of memory, scoped to system main RAM)
    mainmemory_read_u8 = mainmemory and has(mainmemory, "read_u8"),
    -- gameinfo
    gameinfo_getromname = gameinfo and has(gameinfo, "getromname"),
    gameinfo_getromhash = gameinfo and has(gameinfo, "getromhash"),
}

-- ── Command handlers ────────────────────────────────────────────────────────

local function cmd_ping(p) return "pong" end

-- BizHawk's memory.getmemorydomainlist() hands us a 0-indexed Lua table. The
-- JSON encoder (correctly) sees non-1-indexed keys and serializes it as an
-- OBJECT (`{"0":"CARTRAM","1":"WRAM",...}`) rather than an ARRAY. Re-pack into
-- a contiguous 1-indexed array so the client side sees a clean JSON array.
local function memory_domain_list()
    if not CAPS.memory_get_memorydomain_list then return nil end
    local raw = memory.getmemorydomainlist()
    local out = {}
    -- Could be 0-indexed or 1-indexed depending on build; walk by ipairs from
    -- 0 in case key 0 is the first slot, then continue with positive keys.
    local i = raw[0] ~= nil and 0 or 1
    while raw[i] ~= nil do
        out[#out + 1] = raw[i]
        i = i + 1
    end
    return out
end

local function cmd_get_info(p)
    return {
        rom_name      = CAPS.gameinfo_getromname and gameinfo.getromname() or nil,
        rom_hash      = CAPS.gameinfo_getromhash and gameinfo.getromhash() or nil,
        framecount    = CAPS.framecount and emu.framecount() or nil,
        memory_domains = memory_domain_list(),
        -- Which domain is read/written when a memory tool call omits `domain`.
        -- Useful because BizHawk's "current" domain can drift after savestate
        -- loads or other Lua scripts changing it underneath us.
        current_memory_domain = CAPS.memory_get_current_memorydomain
            and memory.getcurrentmemorydomain() or nil,
        capabilities  = CAPS,
    }
end

-- Memory r/w. By default operates on the current "main memory" domain;
-- pass `domain` in params to target a specific named domain (use
-- list_memory_domains to discover names — they vary per system).
local function in_domain(domain, fn)
    if not domain then return fn() end
    if not CAPS.memory_use_memory_domain then
        error("memory.usememorydomain not available on this BizHawk build")
    end
    local prev = memory.getcurrentmemorydomain and memory.getcurrentmemorydomain() or nil
    local ok = memory.usememorydomain(domain)
    if not ok then error("unknown memory domain: " .. tostring(domain)) end
    local r = fn()
    if prev then memory.usememorydomain(prev) end
    return r
end

-- Read a single value of the given width ("u8"/"u16"/"u32") at `address` in the
-- CURRENT memory domain. Little-endian (BizHawk's default), matching the
-- read16/read32 tools. Shared by read_memory_widthed and the memory search.
local function read_at_width(address, width)
    if     width == "u8"  then return memory.read_u8(address)
    elseif width == "u16" then return memory.read_u16_le(address)
    elseif width == "u32" then return memory.read_u32_le(address)
    else error("width must be 'u8', 'u16', or 'u32' (got " .. tostring(width) .. ")") end
end

local function cmd_read8(p)
    local addr = assert(p.address, "address required")
    return in_domain(p.domain, function() return memory.read_u8(addr) end)
end
local function cmd_read16(p)
    local addr = assert(p.address, "address required")
    return in_domain(p.domain, function() return memory.read_u16_le(addr) end)
end
local function cmd_read32(p)
    local addr = assert(p.address, "address required")
    return in_domain(p.domain, function() return memory.read_u32_le(addr) end)
end
local function cmd_write8(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    in_domain(p.domain, function() memory.write_u8(addr, val) end)
    return true
end
local function cmd_write16(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    in_domain(p.domain, function() memory.write_u16_le(addr, val) end)
    return true
end
local function cmd_write32(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    in_domain(p.domain, function() memory.write_u32_le(addr, val) end)
    return true
end

local function cmd_read_range(p)
    local addr = assert(p.address, "address required")
    local len  = assert(p.length,  "length required")
    if len > 4096 then error("length exceeds 4096 byte limit") end
    return in_domain(p.domain, function()
        local bytes = {}
        for i = 0, len - 1 do bytes[i + 1] = memory.read_u8(addr + i) end
        return bytes
    end)
end

local function cmd_write_range(p)
    local addr  = assert(p.address, "address required")
    local bytes = assert(p.bytes,   "bytes required")
    if #bytes > 4096 then error("byte count exceeds 4096 limit") end
    return in_domain(p.domain, function()
        for i, b in ipairs(bytes) do memory.write_u8(addr + i - 1, b) end
        return { written = #bytes }
    end)
end

-- ── Memory search ───────────────────────────────────────────────────────────
--
-- Two modes, mirroring a Cheat-Engine "first scan" / "next scan" workflow:
--   * FIRST scan: no `addresses` given — sweep a contiguous region of the
--     domain for cells equal to `value` and return the matching offsets.
--   * NEXT scan: `addresses` given (the offsets a prior scan returned) — re-read
--     only those and keep the ones that STILL equal `value`. Exact and cheap.
--
-- The first scan briefly stalls the emulator (it runs synchronously inside one
-- bridge tick). We bulk-read the region in one engine call when the build
-- exposes a bulk reader, and fall back to a read_u8 loop (with a tighter cap)
-- otherwise.
local SEARCH_BULK_CAP   = 16 * 1024 * 1024  -- max bytes/scan via bulk read
local SEARCH_LOOP_CAP   = 262144            -- max bytes/scan via read_u8 fallback
local SEARCH_RESULT_MAX = 5000              -- hard ceiling on returned offsets

local function width_meta(width)
    if     width == "u8"  then return 1, 0xFF
    elseif width == "u16" then return 2, 0xFFFF
    elseif width == "u32" then return 4, 0xFFFFFFFF
    else error("width must be 'u8', 'u16', or 'u32' (got " .. tostring(width) .. ")") end
end

-- Bulk-read `len` bytes from `addr` in the CURRENT domain into a 1-indexed Lua
-- array, or return nil if this build exposes no bulk reader (caller loops).
-- BizHawk's bulk readers are 0-indexed; re-pack to 1-indexed.
local function bulk_read_bytes(addr, len)
    local raw
    if     CAPS.memory_read_bytes_as_array then raw = memory.read_bytes_as_array(addr, len)
    elseif CAPS.memory_readbyterange       then raw = memory.readbyterange(addr, len)
    else return nil end
    local out = {}
    local base = (raw[0] ~= nil) and 0 or 1
    for i = 0, len - 1 do out[i + 1] = raw[base + i] end
    return out
end

local function cmd_search_memory(p)
    local value = assert(p.value, "value required")
    local width = p.width or "u16"
    local wbytes, wmax = width_meta(width)
    if value < 0 or value > wmax then
        error(string.format("value %d out of range for width %s (0..%d)", value, width, wmax))
    end
    local cap = p.max_results or 200
    if cap < 1 then cap = 1 elseif cap > SEARCH_RESULT_MAX then cap = SEARCH_RESULT_MAX end

    -- NEXT scan: filter a caller-supplied candidate set.
    if p.addresses ~= nil then
        if type(p.addresses) ~= "table" then error("addresses must be an array of domain offsets") end
        return in_domain(p.domain, function()
            local kept, total = {}, 0
            for _, addr in ipairs(p.addresses) do
                if read_at_width(addr, width) == value then
                    total = total + 1
                    if #kept < cap then kept[#kept + 1] = addr end
                end
            end
            return { mode = "next", addresses = kept, count = total,
                     candidates = #p.addresses, truncated = total > #kept }
        end)
    end

    -- FIRST scan: sweep a contiguous region.
    local aligned = p.aligned
    if aligned == nil then aligned = true end
    local step  = aligned and wbytes or 1
    local start = p.start or 0
    if start < 0 then error("start must be >= 0") end

    local length = p.length
    if not length then
        if not CAPS.memory_get_memorydomainsize then
            error("no `length` given and memory.getmemorydomainsize is unavailable on this build — pass start+length to bound the scan")
        end
        local size = p.domain and memory.getmemorydomainsize(p.domain) or memory.getmemorydomainsize()
        length = size - start
    end
    if length < wbytes then error("scan range smaller than one " .. width .. " value") end

    local have_bulk = CAPS.memory_read_bytes_as_array or CAPS.memory_readbyterange
    local cap_bytes = have_bulk and SEARCH_BULK_CAP or SEARCH_LOOP_CAP
    if length > cap_bytes then
        error(string.format("scan length %d exceeds the per-call cap of %d bytes (%s) — narrow with start+length and chunk",
            length, cap_bytes, have_bulk and "bulk read" or "no bulk-read API on this build"))
    end

    return in_domain(p.domain, function()
        local bytes = bulk_read_bytes(start, length)  -- 1-indexed, or nil
        local matches, total = {}, 0
        local o = 0
        while o <= length - wbytes do
            local v
            if bytes then
                if     width == "u8"  then v = bytes[o + 1]
                elseif width == "u16" then v = bytes[o + 1] + bytes[o + 2] * 256
                else                       v = bytes[o + 1] + bytes[o + 2] * 256 + bytes[o + 3] * 65536 + bytes[o + 4] * 16777216 end
            else
                v = read_at_width(start + o, width)
            end
            if v == value then
                total = total + 1
                if #matches < cap then matches[#matches + 1] = start + o end
            end
            o = o + step
        end
        return { mode = "first", addresses = matches, count = total,
                 scanned = length, truncated = total > #matches }
    end)
end

local function cmd_list_memory_domains(p)
    if not CAPS.memory_get_memorydomain_list then
        error("memory.getmemorydomainlist not available")
    end
    return memory_domain_list()
end

-- Joypad. p.buttons is a table like {A=true, Up=true, Start=true}.
-- p.player defaults to 1.
local function set_joypad(buttons, player)
    if not CAPS.joypad_set then error("joypad.set not available") end
    joypad.set(buttons or {}, player or 1)
end

local function cmd_press_buttons(p)
    local buttons = assert(p.buttons, "buttons required (table like {A=true, Up=true})")
    set_joypad(buttons, p.player or 1)
    return true
end

-- Set several controllers for the SAME upcoming frame. `p.players` is an array
-- of { player = N, buttons = {A=true, ...} }. The bridge does exactly one
-- emu.frameadvance() per tick, so two separate press_buttons calls land on
-- DIFFERENT frames; applying them all here, before the next single frame
-- advance, makes them act simultaneously (e.g. P1 + P2 in a 2-player game).
local function cmd_press_buttons_multi(p)
    local players = assert(p.players, "players required (array of {player, buttons})")
    if type(players) ~= "table" then error("players must be an array") end
    local applied = {}
    for _, entry in ipairs(players) do
        local player  = (type(entry) == "table" and entry.player)  or 1
        local buttons = (type(entry) == "table" and entry.buttons) or {}
        set_joypad(buttons, player)
        applied[#applied + 1] = player
    end
    return { players = applied }
end

-- Batched input playback. Takes a list of per-frame inputs and runs them
-- entirely server-side — one bridge round-trip per BATCH instead of per
-- frame. Each frame entry is `{ buttons = {A=true,...}, player = 1 }`.
-- The bridge does NOT poll its outer loop during this call, so other RPCs
-- (and the heartbeat) are stalled until the batch finishes. For
-- responsiveness, callers should chunk long sequences into multiple
-- play_input_sequence calls of a few hundred frames each.
--
-- Optional observation params (since v0.1.4):
--   p.screenshot_every  — capture a PNG every N frames (also captures the
--                         final frame regardless of remainder). Requires
--                         client.screenshot to be available on this build.
--   p.screenshot_dir    — directory for PNGs (default: C:/temp on Windows,
--                         /tmp elsewhere; caller should ensure it exists)
--   p.screenshot_prefix — filename prefix (default: "obs")
--
-- Optional observation params (since v0.1.5):
--   p.observe_memory    — array of {name, domain, address, width} reads
--                         to perform at each observation point. width is
--                         "u8" | "u16" | "u32". Results land in each
--                         observation as `memory = { name = value, ... }`.
--   p.stop_on_memory_change — {domain, address, width} — record this
--                         value at the start, abort play the moment it
--                         changes. Result includes stopped_early=true and
--                         stop_reason='memory_changed'. The final
--                         observation (if screenshot/memory enabled) is
--                         always captured at the stop frame.
local function read_memory_widthed(domain, address, width)
    return in_domain(domain, function() return read_at_width(address, width) end)
end

local function cmd_play_input_sequence(p)
    if not CAPS.joypad_set    then error("joypad.set not available") end
    if not CAPS.frameadvance  then error("emu.frameadvance not available") end
    local frames = assert(p.frames, "frames required (array of {buttons, player?} objects)")
    if type(frames) ~= "table" then error("frames must be an array") end

    local screenshot_every  = p.screenshot_every
    local screenshot_dir    = p.screenshot_dir    or "C:/temp"
    local screenshot_prefix = p.screenshot_prefix or "obs"
    if screenshot_every and not CAPS.screenshot then
        error("screenshot_every requested but client.screenshot is not available on this build")
    end

    local observe_memory = p.observe_memory  -- nil or array of {name, domain, address, width}
    local stop_spec      = p.stop_on_memory_change  -- nil or {domain, address, width}

    -- Capture initial value for stop-on-change
    local stop_initial = nil
    if stop_spec then
        stop_initial = read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width)
    end

    local observations = {}
    local count   = 0
    local total   = #frames
    local stopped = false
    local stop_reason = nil

    -- Helper: capture an observation at the current frame.
    local function capture_observation()
        local obs = { frame_offset = count }
        if screenshot_every then
            local path = string.format("%s/%s-%04d.png", screenshot_dir, screenshot_prefix, count)
            client.screenshot(path)
            obs.path = path
        end
        if observe_memory then
            local mem = {}
            for _, spec in ipairs(observe_memory) do
                mem[spec.name] = read_memory_widthed(spec.domain, spec.address, spec.width)
            end
            obs.memory = mem
        end
        table.insert(observations, obs)
    end

    for i, frame in ipairs(frames) do
        local buttons = (type(frame) == "table" and frame.buttons) or {}
        local player  = (type(frame) == "table" and frame.player) or 1
        joypad.set(buttons, player)
        emu.frameadvance()
        count = count + 1

        -- Check stop condition AFTER the frame advances
        if stop_spec then
            local cur = read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width)
            if cur ~= stop_initial then
                stopped = true
                stop_reason = "memory_changed"
                -- Always capture the stop frame as an observation (regardless of screenshot_every cadence)
                if screenshot_every or observe_memory then
                    capture_observation()
                end
                break
            end
        end

        -- Periodic observation (only if we didn't already capture for stop)
        if (screenshot_every or observe_memory) and (count % (screenshot_every or 0xFFFF) == 0 or count == total) then
            capture_observation()
        end
    end

    return {
        played = count,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
        observations = observations,
        stopped_early = stopped,
        stop_reason = stop_reason,
    }
end

local function cmd_pause(p)
    if not CAPS.pause then error("emu.pause not available") end
    emu.pause(); return true
end
local function cmd_unpause(p)
    if not CAPS.unpause then error("emu.unpause not available") end
    emu.unpause(); return true
end
local function cmd_frame_advance(p)
    if not CAPS.frameadvance then error("emu.frameadvance not available") end
    local n = p.count or 1
    for _ = 1, n do emu.frameadvance() end
    return CAPS.framecount and emu.framecount() or nil
end
local function cmd_reset(p)
    if not CAPS.reboot_core then error("client.reboot_core not available") end
    client.reboot_core(); return true
end

local function cmd_screenshot(p)
    if not CAPS.screenshot then error("client.screenshot not available") end
    local path = assert(p.path, "path required (BizHawk's client.screenshot needs an explicit path)")
    client.screenshot(path)
    return path
end

local function cmd_save_state(p)
    if not CAPS.savestate_save then error("savestate.save not available") end
    local path = assert(p.path, "path required (BizHawk savestates are file-based)")
    savestate.save(path)
    return { path = path }
end
local function cmd_load_state(p)
    if not CAPS.savestate_load then error("savestate.load not available") end
    local path = assert(p.path, "path required")
    savestate.load(path)
    return { path = path }
end

-- ── Dispatch table ──────────────────────────────────────────────────────────

local HANDLERS = {
    ping                 = cmd_ping,
    get_info             = cmd_get_info,
    read8                = cmd_read8,
    read16               = cmd_read16,
    read32               = cmd_read32,
    write8               = cmd_write8,
    write16              = cmd_write16,
    write32              = cmd_write32,
    read_range           = cmd_read_range,
    write_range          = cmd_write_range,
    search_memory        = cmd_search_memory,
    list_memory_domains  = cmd_list_memory_domains,
    press_buttons        = cmd_press_buttons,
    press_buttons_multi  = cmd_press_buttons_multi,
    play_input_sequence  = cmd_play_input_sequence,
    pause                = cmd_pause,
    unpause              = cmd_unpause,
    frame_advance        = cmd_frame_advance,
    reset                = cmd_reset,
    screenshot           = cmd_screenshot,
    save_state           = cmd_save_state,
    load_state           = cmd_load_state,
}

local function dispatch(cmd)
    if not cmd.method then
        return nil, { code = -32600, message = "missing method field" }
    end
    local handler = HANDLERS[cmd.method]
    if not handler then
        return nil, { code = -32601, message = "unknown method: " .. cmd.method }
    end
    local ok, result = pcall(handler, cmd.params or {})
    if not ok then
        return nil, { code = -32603, message = tostring(result) }
    end
    return result, nil
end

-- ── Per-frame round trip with the external server ──────────────────────────
--
-- API notes (from BizHawk 2.11's Lua/_docs_luacats/comm.d.lua):
--   * `comm.socketServerSend(s)` returns an INTEGER (status / bytes sent).
--     Pure send — does NOT return the reply.
--   * `comm.socketServerResponse()` reads the next message from the socket.
--     CRITICAL: "all responses must be of the form `{msg.Length:D} {msg}`
--     i.e. prefixed with the length in base-10 and a space." That applies
--     to INCOMING messages too — BizHawk's parser silently discards lines
--     that aren't length-prefixed. The Node side prefixes everything before
--     writing, so by the time the response gets here BizHawk has already
--     stripped the prefix and we receive just `<msg>` (no length, no newline).
--
-- Pattern: receive at start of frame (reads response to previous frame's
-- send), then send for this frame. Decouples send and receive across a full
-- frame boundary (~16ms) so the receive timeout doesn't have to be tuned to
-- network round-trip time.
local function tick()
    -- Step 1: receive response from PREVIOUS frame's send (if any).
    local incoming = comm.socketServerResponse()

    if incoming and type(incoming) == "string" and #incoming > 0 then
        incoming = incoming:gsub("[\r\n]+$", "")
        if incoming ~= "NONE" and #incoming > 0 then
            local parse_ok, cmd = pcall(json.decode, incoming)
            if parse_ok and type(cmd) == "table" then
                local result, rpc_err = dispatch(cmd)
                if rpc_err then
                    pending_result = { id = cmd.id, error = rpc_err }
                else
                    pending_result = { id = cmd.id, result = result }
                end
            else
                pending_result = { id = nil, error = { code = -32700, message = "parse error" } }
            end
        end
    end

    -- Step 2: send for THIS frame.
    local outgoing
    if pending_result then
        outgoing = "RESULT " .. json.encode(pending_result)
        pending_result = nil
    else
        outgoing = "READY"
    end
    comm.socketServerSend(outgoing .. "\n")
end

-- ── Startup ────────────────────────────────────────────────────────────────

console.log("[mcp-bizhawk] bridge starting")

if not (comm and comm.socketServerSend and comm.socketServerResponse) then
    console.log("[mcp-bizhawk] FATAL: comm.socketServer* not available — launch BizHawk with --socket_ip / --socket_port flags pointing at a running mcp-bizhawk server")
    return
end

local ip   = comm.socketServerGetIp   and comm.socketServerGetIp()   or "(unknown)"
local port = comm.socketServerGetPort and comm.socketServerGetPort() or "(unknown)"
console.log(string.format("[mcp-bizhawk] socket server target: %s:%s", tostring(ip), tostring(port)))

-- Receive timeout for socketServerResponse(). Default BizHawk timeout (5ms)
-- is fine in steady state — replies are sitting in the socket buffer by the
-- time we poll for them — but a slightly longer window costs us nothing and
-- absorbs occasional jitter (GC pause on the Node side, OS scheduling, etc).
if comm.socketServerSetTimeout then
    comm.socketServerSetTimeout(50)
    console.log("[mcp-bizhawk] socket receive timeout set to 50ms")
end

console.log("[mcp-bizhawk] frame loop active — bridge is polling once per frame")

-- Per-frame poll. Run forever.
local last_connection_state = comm.socketServerIsConnected and comm.socketServerIsConnected() or true
local tick_count = 0
while true do
    tick_count = tick_count + 1

    -- Watch for connection state changes (cheap to check once per second).
    if tick_count % 60 == 0 and comm.socketServerIsConnected then
        local connected = comm.socketServerIsConnected()
        if connected ~= last_connection_state then
            console.log("[mcp-bizhawk] socket connected = " .. tostring(connected))
            last_connection_state = connected
        end
    end

    tick()
    emu.frameadvance()
end
