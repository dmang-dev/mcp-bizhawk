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

local function cmd_list_memory_domains(p)
    if not CAPS.memory_get_memorydomain_list then
        error("memory.getmemorydomainlist not available")
    end
    return memory_domain_list()
end

-- Joypad. p.buttons is a table like {A=true, Up=true, Start=true}.
-- p.player defaults to 1.
local function cmd_press_buttons(p)
    if not CAPS.joypad_set then error("joypad.set not available") end
    local buttons = assert(p.buttons, "buttons required (table like {A=true, Up=true})")
    local player  = p.player or 1
    joypad.set(buttons, player)
    return true
end

-- Batched input playback. Takes a list of per-frame inputs and runs them
-- entirely server-side — one bridge round-trip per BATCH instead of per
-- frame. Each frame entry is `{ buttons = {A=true,...}, player = 1 }`.
-- The bridge does NOT poll its outer loop during this call, so other RPCs
-- (and the heartbeat) are stalled until the batch finishes. For
-- responsiveness, callers should chunk long sequences into multiple
-- play_input_sequence calls of a few hundred frames each.
local function cmd_play_input_sequence(p)
    if not CAPS.joypad_set    then error("joypad.set not available") end
    if not CAPS.frameadvance  then error("emu.frameadvance not available") end
    local frames = assert(p.frames, "frames required (array of {buttons, player?} objects)")
    if type(frames) ~= "table" then error("frames must be an array") end

    local count = 0
    for i, frame in ipairs(frames) do
        local buttons = (type(frame) == "table" and frame.buttons) or {}
        local player  = (type(frame) == "table" and frame.player) or 1
        joypad.set(buttons, player)
        emu.frameadvance()
        count = count + 1
    end

    return {
        played = count,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
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
    list_memory_domains  = cmd_list_memory_domains,
    press_buttons        = cmd_press_buttons,
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
