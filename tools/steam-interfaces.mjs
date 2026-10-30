/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steamworks interfaces' layouts, read from the SDK's headers: for every
 * version a game may ask the client for, its methods in vtable order, how
 * many bytes of arguments each takes on an x86 stack (after `this`, which a
 * thiscall method has in ECX), and how it returns -- which is what the
 * engine's Steam client needs to place a method a game calls through a
 * vtable and pop what the caller pushed. Written to
 * modules/core/src/layers/win32/steamclient/interfaces.js.
 *
 *   node tools/steam-interfaces.mjs <directory of isteam*.h>
 *
 * A directory of the headers of every version, numbered (isteamuser017.h)
 * and current (isteamuser.h), as projects that keep the SDK's history carry
 * them. Returns: `v` void, `i` four bytes in EAX, `q` eight in EDX:EAX, `f`
 * float on the x87 stack, `s8` an eight-byte class (CSteamID, CGameID)
 * through a hidden pointer the caller pushes first, `sN` an N-byte struct
 * likewise.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory] = process.argv.slice(2);
if (!directory)
{
    throw new Error('usage: node tools/steam-interfaces.mjs <directory of isteam*.h>');
}

/** How each family's version strings are spelled, before the three digits. */
const PREFIXES = {
    ISteamClient: 'SteamClient', ISteamUser: 'SteamUser', ISteamFriends: 'SteamFriends',
    ISteamUtils: 'SteamUtils', ISteamMatchmaking: 'SteamMatchMaking',
    ISteamMatchmakingServers: 'SteamMatchMakingServers',
    ISteamUserStats: 'STEAMUSERSTATS_INTERFACE_VERSION', ISteamApps: 'STEAMAPPS_INTERFACE_VERSION',
    ISteamNetworking: 'SteamNetworking',
    ISteamRemoteStorage: 'STEAMREMOTESTORAGE_INTERFACE_VERSION',
    ISteamScreenshots: 'STEAMSCREENSHOTS_INTERFACE_VERSION',
    ISteamHTTP: 'STEAMHTTP_INTERFACE_VERSION',
    ISteamGameServer: 'SteamGameServer', ISteamGameServerStats: 'SteamGameServerStats',
    ISteamUGC: 'STEAMUGC_INTERFACE_VERSION', ISteamController: 'SteamController',
    ISteamInput: 'SteamInput', ISteamAppList: 'STEAMAPPLIST_INTERFACE_VERSION',
    ISteamMusic: 'STEAMMUSIC_INTERFACE_VERSION',
    ISteamMusicRemote: 'STEAMMUSICREMOTE_INTERFACE_VERSION',
    ISteamHTMLSurface: 'STEAMHTMLSURFACE_INTERFACE_VERSION_',
    ISteamInventory: 'STEAMINVENTORY_INTERFACE_V', ISteamVideo: 'STEAMVIDEO_INTERFACE_V',
    ISteamParentalSettings: 'STEAMPARENTALSETTINGS_INTERFACE_VERSION',
    ISteamUnifiedMessages: 'STEAMUNIFIEDMESSAGES_INTERFACE_VERSION',
    ISteamGameSearch: 'SteamMatchGameSearch', ISteamParties: 'SteamParties',
    ISteamRemotePlay: 'STEAMREMOTEPLAY_INTERFACE_VERSION',
};

/** Types eight bytes wide on an x86 stack. */
const WIDE = /^(u?int64(_t)?|CSteamID|CGameID|SteamAPICall_t|UGCHandle_t|PublishedFileId_t|UGCQueryHandle_t|UGCUpdateHandle_t|SteamLeaderboard_t|SteamLeaderboardEntries_t|double|PublishedFileUpdateHandle_t|UGCFileWriteStreamHandle_t|SteamItemInstanceID_t|SteamInventoryUpdateHandle_t|ControllerHandle_t|InputHandle_t|ControllerActionSetHandle_t|ControllerDigitalActionHandle_t|ControllerAnalogActionHandle_t|InputActionSetHandle_t|InputDigitalActionHandle_t|InputAnalogActionHandle_t|ClientUnifiedMessageHandle|PartyBeaconID_t|ManifestId_t|UGCHandle|SteamItemDef_t64)$/;
/** Classes returned through a hidden pointer, and their size. */
const BY_POINTER = { CSteamID: 8, CGameID: 8, SteamIPAddress_t: 20, InputAnalogActionData_t: 13,
    InputDigitalActionData_t: 2, InputMotionData_t: 40, ControllerAnalogActionData_t: 13,
    ControllerDigitalActionData_t: 2, ControllerMotionData_t: 40, SteamNetworkingIdentity: 136 };

/** @param {string} text  A type as written, its name and qualifiers. */
const bare = text=>text.replace(/\b(const|struct|enum|class|unsigned|volatile)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

/** @param {string} type @returns {string} */
function returnKind(type){
    const t = bare(type);
    if (t === 'void')
    {
        return 'v';
    }
    if (/[*&]$/.test(t))
    {
        return 'i';
    }
    if (t === 'float')
    {
        return 'f';
    }
    if (t in BY_POINTER)
    {
        return `s${BY_POINTER[/** @type {keyof typeof BY_POINTER} */ (t)]}`;
    }
    return WIDE.test(t) ? 'q' : 'i';
}

/** @param {string} parameters @returns {number} */
function argumentBytes(parameters){
    const list = parameters.trim();
    if (list === '' || list === 'void')
    {
        return 0;
    }
    let bytes = 0;
    // Split at the commas outside parentheses: a function pointer's own
    // parameter list is one parameter.
    for (const raw of list.split(/,(?![^(]*\))/))
    {
        const declaration = raw.replace(/=.*$/s, '').trim();
        if (/[*&]/.test(declaration) || /\[\s*\w*\s*\]\s*$/.test(declaration))
        {
            bytes += 4;
            continue;
        }
        const type = bare(declaration.replace(/\s*\w+\s*$/, ''));
        bytes += WIDE.test(type) ? 8 : type === 'double' ? 8 : 4;
    }
    return bytes;
}

/** What a 32-bit Windows client build defines; anything else is not defined. */
const DEFINED = new Set(['STEAM_WIN32', '_WIN32', 'WIN32', 'VALVE_CALLBACK_PACK_LARGE']);

/**
 * The lines a 32-bit Windows build compiles: a method under `#ifdef _PS3` is
 * no slot of the Windows vtable. Header guards and unknown conditions are
 * taken as true.
 *
 * @param {string} text
 */
function preprocess(text){
    /** @type {{ taking: boolean, taken: boolean }[]} */
    const stack = [];
    const on = ()=>stack.every(level=>level.taking);
    /** @param {string} condition */
    const holds = condition=>{
        const expression = condition.replace(/defined\s*\(\s*(\w+)\s*\)/g,
            (_, name)=>String(DEFINED.has(name)));
        return /^[\s()!&|truefals]*$/.test(expression)
            ? Boolean(new Function(`return (${expression});`)()) : true;
    };
    const out = [];
    for (const line of text.split('\n'))
    {
        const directive = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b\s*(.*)$/.exec(line);
        if (!directive)
        {
            out.push(on() ? line : '');
            continue;
        }
        const [, kind, rest] = directive;
        const name = rest.trim().split(/\s/)[0];
        if (kind === 'ifdef' || kind === 'ifndef' || kind === 'if')
        {
            const taking = kind === 'ifdef' ? DEFINED.has(name)
                : kind === 'ifndef' ? !DEFINED.has(name) : holds(rest);
            stack.push({ taking, taken: taking });
        }
        else if (kind === 'elif' && stack.length > 0)
        {
            const level = stack[stack.length - 1];
            level.taking = !level.taken && holds(rest);
            level.taken ||= level.taking;
        }
        else if (kind === 'else' && stack.length > 0)
        {
            const level = stack[stack.length - 1];
            level.taking = !level.taken;
            level.taken = true;
        }
        else if (kind === 'endif')
        {
            stack.pop();
        }
        out.push('');
    }
    return out.join('\n');
}

/** @type {Record<string, string>} */
const interfaces = {};
for (const file of readdirSync(directory).filter(name=>/^isteam[a-z]+\d*\.h$/.test(name)).sort())
{
    const text = preprocess(readFileSync(join(directory, file), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        // A private method is still a slot: its wrapper goes, the method stays.
        .replace(/\bSTEAM_PRIVATE_API\s*\(\s*(virtual[^;]*;)\s*\)/g, '$1')
        // The SDK's annotations, which carry no type.
        .replace(/\bSTEAM_[A-Z_]+\s*\((?:[^()]|\([^()]*\))*\)/g, ' ');
    const defines = new Map([...text.matchAll(/#define\s+(\w+)\s+"([^"]+)"/g)]
        .map(match=>[match[1], match[2]]));
    for (const match of text.matchAll(/class\s+(I\w+?)(\d{3})?\s*(?::[^{;]*)?\{([\s\S]*?)\n\};/g))
    {
        const [, family, number, body] = match;
        const prefix = PREFIXES[/** @type {keyof typeof PREFIXES} */ (family)];
        if (!prefix)
        {
            continue;
        }
        const version = number ? `${prefix}${number}`
            : [...defines.values()].find(value=>value.startsWith(prefix)
                && /^\d{3}$/.test(value.slice(prefix.length)));
        if (!version)
        {
            continue;
        }
        // A method, or a virtual destructor, which takes a slot too: MSVC's
        // deleting destructor, its flags on the stack. A parameter may hold
        // parentheses of its own: `void (*)()`.
        const declaration = new RegExp(String.raw`virtual\s+(?:~\w+\s*\(\s*\)|`
            + String.raw`([\w\s:*&<>]+?)\s*\b(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s*`
            + String.raw`(?:const\s*)?=\s*0\s*;)`, 'g');
        const methods = [...body.matchAll(declaration)].map(([, type, name, parameters])=>(
            name === undefined ? '~:4:i'
                : `${name}:${argumentBytes(parameters)}:${returnKind(type)}`));
        if (methods.length > 0)
        {
            interfaces[version] = methods.join(',');
        }
    }
}

/**
 * Version strings that are not the family's prefix and a number: the first
 * controller interface was asked for by its macro's own name, which a game
 * built with that SDK still asks for.
 */
const ALIASES = { STEAMCONTROLLER_INTERFACE_VERSION: 'SteamController001' };
for (const [alias, version] of Object.entries(ALIASES))
{
    if (interfaces[version])
    {
        interfaces[alias] = interfaces[version];
    }
}

const out = new URL('../modules/core/src/layers/win32/steamclient/interfaces.js', import.meta.url);
writeFileSync(out, `/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steamworks interfaces' layouts by version string, as the SDK's headers
 * declare them (written by tools/steam-interfaces.mjs, not by hand): each a
 * list of \`name:bytes:return\`, in vtable order -- the bytes of arguments
 * after \`this\` on an x86 stack, and how the method returns (\`v\` void, \`i\`
 * EAX, \`q\` EDX:EAX, \`f\` x87, \`sN\` an N-byte class through a hidden pointer).
 */

/* eslint-disable max-len */
/** @type {Record<string, string>} */
export const INTERFACES = ${JSON.stringify(interfaces, null, 4).replace(/"/g, '\'')};
`);
console.log(`${Object.keys(interfaces).length} versions`);
