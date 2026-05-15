-- json.lua: minimal JSON encode/decode for BizHawk's Lua environment.
-- Same library used by mcp-mgba's bridge (no external deps).

local json = {}

local escape_map = {
    ['"']  = '\\"',
    ['\\'] = '\\\\',
    ['\n'] = '\\n',
    ['\r'] = '\\r',
    ['\t'] = '\\t',
}

local function encode_string(s)
    return '"' .. s:gsub('["\\\n\r\t]', escape_map) .. '"'
end

local encode_value

local function encode_array(t, n)
    local parts = {}
    for i = 1, n do parts[i] = encode_value(t[i]) end
    return "[" .. table.concat(parts, ",") .. "]"
end

local function encode_object(t)
    local parts = {}
    for k, v in pairs(t) do
        parts[#parts + 1] = encode_string(tostring(k)) .. ":" .. encode_value(v)
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

encode_value = function(v)
    local tv = type(v)
    if tv == "nil"     then return "null"
    elseif tv == "boolean" then return tostring(v)
    elseif tv == "number"  then
        if v ~= v then return "null" end
        if v == math.huge or v == -math.huge then return "null" end
        if math.floor(v) == v then return string.format("%d", v) end
        return string.format("%.17g", v)
    elseif tv == "string" then
        return encode_string(v)
    elseif tv == "table" then
        local n = #v
        local is_arr = (n > 0)
        if is_arr then
            for k in pairs(v) do
                if type(k) ~= "number" or k < 1 or k > n or math.floor(k) ~= k then
                    is_arr = false; break
                end
            end
        else
            local has_keys = false
            for _ in pairs(v) do has_keys = true; break end
            if not has_keys then return "{}" end
        end
        return is_arr and encode_array(v, n) or encode_object(v)
    end
    return "null"
end

function json.encode(v) return encode_value(v) end

local function skip_ws(s, i)
    while i <= #s do
        local c = s:sub(i, i)
        if c == ' ' or c == '\t' or c == '\n' or c == '\r' then i = i + 1
        else break end
    end
    return i
end

local decode_value

local function decode_string(s, i)
    i = i + 1
    local buf = {}
    while i <= #s do
        local c = s:sub(i, i)
        if c == '"' then return table.concat(buf), i + 1
        elseif c == '\\' then
            local e = s:sub(i + 1, i + 1)
            if     e == '"'  then buf[#buf+1] = '"';  i = i + 2
            elseif e == '\\' then buf[#buf+1] = '\\'; i = i + 2
            elseif e == '/'  then buf[#buf+1] = '/';  i = i + 2
            elseif e == 'n'  then buf[#buf+1] = '\n'; i = i + 2
            elseif e == 'r'  then buf[#buf+1] = '\r'; i = i + 2
            elseif e == 't'  then buf[#buf+1] = '\t'; i = i + 2
            elseif e == 'b'  then buf[#buf+1] = '\b'; i = i + 2
            elseif e == 'f'  then buf[#buf+1] = '\f'; i = i + 2
            elseif e == 'u'  then
                local cp = tonumber(s:sub(i + 2, i + 5), 16)
                if cp and cp < 128 then buf[#buf+1] = string.char(cp)
                else buf[#buf+1] = '?' end
                i = i + 6
            else buf[#buf+1] = e; i = i + 2
            end
        else buf[#buf+1] = c; i = i + 1
        end
    end
    error("json: unterminated string at " .. i)
end

local function decode_number(s, i)
    local j = i
    if s:sub(j, j) == '-' then j = j + 1 end
    while j <= #s and s:sub(j, j):match('%d') do j = j + 1 end
    if j <= #s and s:sub(j, j) == '.' then
        j = j + 1
        while j <= #s and s:sub(j, j):match('%d') do j = j + 1 end
    end
    if j <= #s and s:sub(j, j):match('[eE]') then
        j = j + 1
        if j <= #s and s:sub(j, j):match('[+-]') then j = j + 1 end
        while j <= #s and s:sub(j, j):match('%d') do j = j + 1 end
    end
    return tonumber(s:sub(i, j - 1)), j
end

local function decode_object(s, i)
    local t = {}
    i = skip_ws(s, i + 1)
    if s:sub(i, i) == '}' then return t, i + 1 end
    while true do
        i = skip_ws(s, i)
        local k; k, i = decode_string(s, i)
        i = skip_ws(s, i)
        if s:sub(i, i) ~= ':' then error("json: expected ':' at " .. i) end
        i = skip_ws(s, i + 1)
        local v; v, i = decode_value(s, i)
        t[k] = v
        i = skip_ws(s, i)
        local c = s:sub(i, i)
        if     c == '}' then return t, i + 1
        elseif c == ',' then i = i + 1
        else error("json: expected ',' or '}' at " .. i) end
    end
end

local function decode_array(s, i)
    local t = {}
    i = skip_ws(s, i + 1)
    if s:sub(i, i) == ']' then return t, i + 1 end
    while true do
        i = skip_ws(s, i)
        local v; v, i = decode_value(s, i)
        t[#t + 1] = v
        i = skip_ws(s, i)
        local c = s:sub(i, i)
        if     c == ']' then return t, i + 1
        elseif c == ',' then i = i + 1
        else error("json: expected ',' or ']' at " .. i) end
    end
end

decode_value = function(s, i)
    i = skip_ws(s, i)
    if i > #s then error("json: unexpected end of input") end
    local c = s:sub(i, i)
    if     c == '"' then return decode_string(s, i)
    elseif c == '{' then return decode_object(s, i)
    elseif c == '[' then return decode_array(s, i)
    elseif c == 't' then return true,  i + 4
    elseif c == 'f' then return false, i + 5
    elseif c == 'n' then return nil,   i + 4
    elseif c == '-' or c:match('%d') then return decode_number(s, i)
    else error("json: unexpected character '" .. c .. "' at " .. i) end
end

function json.decode(s) local v, _ = decode_value(s, 1); return v end

return json
