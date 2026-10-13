/* The client side of a raid's frame, as a game's engine drives its interface: the API the
 * addons call (unit health, power, names, auras, time) as C functions, and each frame's
 * events -- sixty combat-log lines, unit updates, a chat line -- pushed through the C API to
 * the scripts' dispatcher, then OnUpdate for every addon. One call of main is one frame; its
 * answer is the scripts' checksum. */
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

extern const char addons_lua[];
extern const unsigned addons_lua_len;
static lua_State *L;
static int fireRef, frameRef, checksumRef;
static double now = 1000.0;
static unsigned rng = 12345;
static unsigned next(void){ rng = rng * 1103515245u + 12345u; return rng >> 8; }
static int health[41], power[41], maxHealth[41];
static char guids[50][20], names[50][16];
/* What a failed load or frame said, for reading out of the guest's memory. */
char lua_error_text[256];

static int unit_of(lua_State *l){
    const char *u = luaL_checkstring(l, 1);
    int n = 0; while (*u && (*u < '0' || *u > '9')) u++;
    while (*u >= '0' && *u <= '9') n = n * 10 + (*u++ - '0');
    return n >= 1 && n <= 40 ? n : 1;
}
static int api_GetTime(lua_State *l){ lua_pushnumber(l, now); return 1; }
static int api_UnitHealth(lua_State *l){ lua_pushinteger(l, health[unit_of(l)]); return 1; }
static int api_UnitHealthMax(lua_State *l){ lua_pushinteger(l, maxHealth[unit_of(l)]); return 1; }
static int api_UnitPower(lua_State *l){ lua_pushinteger(l, power[unit_of(l)]); return 1; }
static int api_UnitName(lua_State *l){ lua_pushstring(l, names[unit_of(l)]); return 1; }
static const char *auraNames[] = { "Power Word: Fortitude", "Renew", "Rejuvenation", "Flame Shock",
    "Corruption", "Bloodlust", "Mark of the Wild", "Arcane Intellect", "Blessing of Kings",
    "Divine Spirit", "Shadow Protection", "Thorns" };
static int api_UnitAura(lua_State *l){
    int u = unit_of(l), i = (int)luaL_checkinteger(l, 2);
    if (i < 1 || i > 4 + u % 9) return 0;
    lua_pushstring(l, auraNames[(u + i) % 12]);
    lua_pushstring(l, "");
    lua_pushstring(l, "Interface\\Icons\\Spell_Holy_WordFortitude");
    lua_pushinteger(l, (u * i) % 3);
    if (i % 4 == 0) lua_pushstring(l, "Magic"); else lua_pushnil(l);
    lua_pushnumber(l, 1800);
    lua_pushnumber(l, now + 30 + (u * 7 + i * 13) % 600);
    lua_pushstring(l, "player");
    lua_pushnil(l);
    lua_pushboolean(l, 0);
    lua_pushinteger(l, 1000 + (u + i) % 12);
    return 11;
}
static const char *subevents[] = { "SPELL_DAMAGE", "SPELL_DAMAGE", "SPELL_DAMAGE", "SPELL_DAMAGE",
    "SWING_DAMAGE", "SWING_DAMAGE", "SPELL_PERIODIC_DAMAGE", "SPELL_HEAL", "SPELL_AURA_APPLIED",
    "SPELL_CAST_START", "RANGE_DAMAGE", "SPELL_PERIODIC_HEAL" };
static const char *spells[] = { "Fireball", "Frostbolt", "Mortal Strike", "Sinister Strike",
    "Shadow Bolt", "Flash Heal", "Renew", "Flame Shock", "Arcane Shot", "Corruption", "Cleave", "Bloodlust" };

static void fire_unit(const char *event, int u){
    char unit[8] = "raid"; int k = 4;
    if (u >= 10) unit[k++] = '0' + u / 10;
    unit[k++] = '0' + u % 10; unit[k] = 0;
    lua_rawgeti(L, LUA_REGISTRYINDEX, fireRef);
    lua_pushstring(L, event);
    lua_pushstring(L, unit);
    lua_call(L, 2, 0);
}
static int frame(lua_State *l){
    (void)l;
    now += 1.0 / 60;
    for (int line = 0; line < 60; line++)
    {
        int src = next() % 50, dst = next() % 50, s = next() % 12, sp = next() % 12;
        lua_rawgeti(L, LUA_REGISTRYINDEX, fireRef);
        lua_pushstring(L, "COMBAT_LOG_EVENT_UNFILTERED");
        lua_pushnumber(L, now);
        lua_pushstring(L, subevents[s]);
        lua_pushstring(L, guids[src]);
        lua_pushstring(L, names[src]);
        lua_pushinteger(L, 0x514);
        lua_pushstring(L, guids[dst]);
        lua_pushstring(L, names[dst]);
        lua_pushinteger(L, 0xa48);
        lua_pushinteger(L, s == 4 || s == 5 ? (int)(next() % 3000) : 1000 + sp);
        lua_pushstring(L, spells[sp]);
        lua_pushinteger(L, 4);
        lua_pushinteger(L, 100 + next() % 9000);
        lua_pushinteger(L, -1);
        lua_call(L, 14, 0);
    }
    for (int k = 0; k < 20; k++) { int u = 1 + next() % 40; health[u] = (health[u] + 997) % maxHealth[u]; fire_unit("UNIT_HEALTH", u); }
    for (int k = 0; k < 20; k++) { int u = 1 + next() % 40; power[u] = (power[u] + 31) % 10000; fire_unit("UNIT_POWER", u); }
    for (int k = 0; k < 8; k++) fire_unit("UNIT_AURA", 1 + next() % 40);
    lua_rawgeti(L, LUA_REGISTRYINDEX, fireRef);
    lua_pushstring(L, next() & 1 ? "CHAT_MSG_PARTY" : "CHAT_MSG_RAID");
    lua_pushstring(L, "|cff1eff00[Heavy Linen Bandage]|r x20 anyone need inv? |cffa335ee[Thunderfury]|r");
    lua_pushstring(L, names[next() % 50]);
    lua_call(L, 3, 0);
    lua_rawgeti(L, LUA_REGISTRYINDEX, frameRef);
    lua_pushnumber(L, 1.0 / 60);
    lua_call(L, 1, 0);
    lua_rawgeti(L, LUA_REGISTRYINDEX, checksumRef);
    lua_call(L, 0, 1);
    return 1;
}
static int start(void){
    L = luaL_newstate();
    lua_pushcfunction(L, luaopen_base); lua_call(L, 0, 0);
    lua_pushcfunction(L, luaopen_string); lua_call(L, 0, 0);
    lua_pushcfunction(L, luaopen_table); lua_call(L, 0, 0);
    lua_pushcfunction(L, luaopen_math); lua_call(L, 0, 0);
    lua_register(L, "GetTime", api_GetTime);
    lua_register(L, "UnitHealth", api_UnitHealth);
    lua_register(L, "UnitHealthMax", api_UnitHealthMax);
    lua_register(L, "UnitPower", api_UnitPower);
    lua_register(L, "UnitName", api_UnitName);
    lua_register(L, "UnitAura", api_UnitAura);
    for (int u = 1; u <= 40; u++) { maxHealth[u] = 3000 + u * 211; health[u] = maxHealth[u] / 2; power[u] = u * 97; }
    for (int g = 0; g < 50; g++)
    {
        guids[g][0] = '0'; guids[g][1] = 'x';
        for (int i = 0; i < 16; i++) { int d = (g * 2654435761u >> (i & 7)) % 16; guids[g][2 + i] = "0123456789ABCDEF"[i < 4 ? 0 : d]; }
        guids[g][18] = 0;
        const char *base = g < 40 ? "Raider" : "Mob";
        strcpy(names[g], base);
        int k = strlen(names[g]); names[g][k++] = 'A' + g % 26; names[g][k++] = 'a' + g / 26; names[g][k] = 0;
    }
    if (luaL_loadbuffer(L, addons_lua, addons_lua_len, "addons") || lua_pcall(L, 0, 0, 0)) return 0;
    lua_getglobal(L, "Fire"); fireRef = luaL_ref(L, LUA_REGISTRYINDEX);
    lua_getglobal(L, "Frame"); frameRef = luaL_ref(L, LUA_REGISTRYINDEX);
    lua_getglobal(L, "Checksum"); checksumRef = luaL_ref(L, LUA_REGISTRYINDEX);
    return 1;
}
int main(void){
    if (!L && !start()) { strncpy(lua_error_text, lua_tostring(L, -1), 255); return 0xbad0; }
    lua_pushcfunction(L, frame);
    if (lua_pcall(L, 0, 1, 0)) { strncpy(lua_error_text, lua_tostring(L, -1), 255); lua_pop(L, 1); return 0xbad1; }
    unsigned r = (unsigned)lua_tonumber(L, -1);
    lua_pop(L, 1);
    return (int)r;
}
