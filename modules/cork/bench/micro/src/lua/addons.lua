-- Dozens of addons as a raid's interface runs them, one frame a call: the client's events
-- fanned out to every addon registered for them, each event's arguments as varargs, handlers
-- reached through metatables and mixins, combat-log bookkeeping by GUID, bar text through
-- string.format, auras scanned through the client's API, timers on OnUpdate, chat parsed with
-- patterns, and the garbage all of that leaves for the collector.
local GetTime, UnitHealth, UnitHealthMax, UnitPower, UnitAura, UnitName =
    GetTime, UnitHealth, UnitHealthMax, UnitPower, UnitAura, UnitName
local format, find, gsub, match, lower = string.format, string.find, string.gsub, string.match, string.lower
local floor, max, min = math.floor, math.max, math.min
local sort, concat, tremove = table.sort, table.concat, table.remove
local select, pairs, tostring, setmetatable = select, pairs, tostring, setmetatable

-- A library's mixins, embedded in every addon.
local Lib = {}
function Lib:RegisterEvent(event, method)
    self.events[event] = method or event
    local list = Registry[event]
    if not list then list = {}; Registry[event] = list end
    list[#list + 1] = self
end
function Lib:ScheduleRepeatingTimer(method, delay)
    self.timers[#self.timers + 1] = { method = method, delay = delay, left = delay }
end
function Lib:Print(...)
    local t = {}
    for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
    self.lastPrint = concat(t, " ")
end
function Lib:OnUpdate(elapsed)
    local timers = self.timers
    for i = 1, #timers do
        local t = timers[i]
        t.left = t.left - elapsed
        if t.left <= 0 then t.left = t.left + t.delay; self[t.method](self) end
    end
end
Registry = {}
local Base = setmetatable({}, { __index = Lib })
Base.__index = Base
local addons = {}
local function NewAddon(name)
    local a = setmetatable({ name = name, events = {}, timers = {}, bars = {},
        db = { profile = { enabled = true, scale = 1, threshold = 5000 } } }, { __index = Base })
    addons[#addons + 1] = a
    return a
end

function Fire(event, ...)
    local list = Registry[event]
    if not list then return end
    for i = 1, #list do
        local a = list[i]
        a[a.events[event]](a, event, ...)
    end
end
function Frame(elapsed)
    for i = 1, #addons do addons[i]:OnUpdate(elapsed) end
end

-- Damage meters.
local function Short(n)
    if n >= 1e6 then return format("%.2fM", n / 1e6) elseif n >= 1e3 then return format("%.1fK", n / 1e3) end
    return tostring(floor(n))
end
for k = 1, 5 do
    local a = NewAddon("Meter" .. k)
    a.sources = {}
    a:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED", "OnCLEU")
    a:ScheduleRepeatingTimer("Refresh", 0.1 + k * 0.01)
    function a:OnCLEU(event, timestamp, subevent, srcGUID, srcName, srcFlags, dstGUID, dstName, dstFlags,
            spellId, spellName, school, amount, overkill)
        if subevent == "SPELL_DAMAGE" or subevent == "SWING_DAMAGE" or subevent == "RANGE_DAMAGE"
                or subevent == "SPELL_PERIODIC_DAMAGE" then
            if subevent == "SWING_DAMAGE" then amount = spellId; spellName = "Melee" end
            local s = self.sources[srcGUID]
            if not s then s = { name = srcName, damage = 0, hits = 0, spells = {} }; self.sources[srcGUID] = s end
            s.damage = s.damage + amount; s.hits = s.hits + 1
            local sp = s.spells[spellName]
            if not sp then sp = { 0, 0 }; s.spells[spellName] = sp end
            sp[1] = sp[1] + amount; sp[2] = sp[2] + 1
        elseif subevent == "SPELL_HEAL" or subevent == "SPELL_PERIODIC_HEAL" then
            local s = self.sources[srcGUID]
            if s then s.healing = (s.healing or 0) + amount end
        end
    end
    function a:Refresh()
        local list = {}
        for _, s in pairs(self.sources) do list[#list + 1] = s end
        sort(list, function(x, y) return x.damage > y.damage end)
        local top = list[1] and list[1].damage or 1
        for i = 1, min(#list, 10) do
            local s = list[i]
            self.bars[i] = format("%d. %s %s (%.1f%%)", i, s.name, Short(s.damage), 100 * s.damage / max(1, top))
        end
    end
end

-- Unit frames.
for k = 1, 6 do
    local a = NewAddon("Frames" .. k)
    a.text = {}
    a:RegisterEvent("UNIT_HEALTH", "OnHealth")
    a:RegisterEvent("UNIT_POWER", "OnPower")
    function a:OnHealth(event, unit)
        local h, m = UnitHealth(unit), UnitHealthMax(unit)
        local pct = floor(h * 100 / max(m, 1) + 0.5)
        if self.db.profile.enabled then
            self.text[unit] = format("%s %s/%s %d%%", UnitName(unit), Short(h), Short(m), pct)
        end
    end
    function a:OnPower(event, unit)
        self.text[unit .. "power"] = Short(UnitPower(unit))
    end
end

-- Aura trackers: every aura of a unit scanned against the triggers, expirations on OnUpdate.
for k = 1, 8 do
    local a = NewAddon("Auras" .. k)
    a.triggers = { ["Power Word: Fortitude"] = true, ["Renew"] = true, ["Rejuvenation"] = k % 2 == 0,
        ["Flame Shock"] = true, ["Corruption"] = k % 3 == 0, ["Bloodlust"] = true }
    a.active = {}
    a:RegisterEvent("UNIT_AURA", "OnAura")
    a:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED", "OnCLEU")
    a:ScheduleRepeatingTimer("Expire", 0.05)
    function a:OnAura(event, unit)
        local i = 1
        while true do
            local name, rank, icon, count, debuffType, duration, expires, caster, stealable, consolidate, spellId = UnitAura(unit, i)
            if not name then break end
            if self.triggers[name] then
                local key = unit .. ":" .. name
                local e = self.active[key]
                if not e then e = {}; self.active[key] = e end
                e.expires, e.count, e.spellId = expires, count, spellId
            end
            i = i + 1
        end
    end
    function a:OnCLEU(event, timestamp, subevent, srcGUID, srcName, srcFlags, dstGUID, dstName, dstFlags, spellId, spellName)
        if subevent == "SPELL_AURA_APPLIED" and self.triggers[spellName] then
            self.lastApplied = dstName .. " " .. spellName
        end
    end
    function a:Expire()
        local now = GetTime()
        for key, e in pairs(self.active) do
            if e.expires < now then self.active[key] = nil end
        end
    end
end

-- Boss mods: spells by id, bar timers rewritten every frame.
for k = 1, 4 do
    local a = NewAddon("Boss" .. k)
    a.spells = { [1001] = "Cleave", [1002] = "Fire Nova", [1003] = "Shadow Bolt Volley", [1004] = "Enrage" }
    a.bars = {}
    a:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED", "OnCLEU")
    function a:OnCLEU(event, timestamp, subevent, srcGUID, srcName, srcFlags, dstGUID, dstName, dstFlags, spellId, spellName)
        if subevent == "SPELL_CAST_START" then
            local s = self.spells[spellId]
            if s then self.bars[s] = { start = GetTime(), duration = 10 + spellId % 7 } end
        end
    end
    function a:OnUpdate(elapsed)
        Lib.OnUpdate(self, elapsed)
        local now = GetTime()
        for name, b in pairs(self.bars) do
            local left = b.duration - (now - b.start)
            if left <= 0 then self.bars[name] = nil
            else b.text = format("%s %d:%02d", name, floor(left / 60), floor(left % 60)) end
        end
    end
end

-- Chat parsers.
for k = 1, 4 do
    local a = NewAddon("Chat" .. k)
    a.seen = 0
    a:RegisterEvent("CHAT_MSG_PARTY", "OnChat")
    a:RegisterEvent("CHAT_MSG_RAID", "OnChat")
    function a:OnChat(event, msg, author)
        local text = lower(msg)
        local item, count = match(text, "%[(.-)%]%s*x(%d+)")
        if item then self.lastItem = item .. "#" .. count end
        local clean = gsub(msg, "|c%x%x%x%x%x%x%x%x(.-)|r", "%1")
        if find(clean, "inv", 1, true) then self.seen = self.seen + 1 end
        self:Print(author, clean, #clean)
    end
end

function Checksum()
    local sum = 0
    for i = 1, #addons do
        local a = addons[i]
        if a.sources then for _, s in pairs(a.sources) do sum = sum + s.damage + (s.healing or 0) end end
        for _, t in pairs(a.bars) do if type(t) == "string" then sum = sum + #t end end
        if a.text then for _, t in pairs(a.text) do sum = sum + #t end end
        if a.seen then sum = sum + a.seen end
    end
    return sum % 2147483647
end
