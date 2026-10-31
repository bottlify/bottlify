/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * steamclient -- the Steam client's side of a game's Steamworks calls,
 * answered by the engine for the account the person signed in with.
 *
 * A game's steam_api.dll finds a running client through the registry
 * (`HKCU\Software\Valve\Steam\ActiveProcess`: the client's pid and the path of
 * its steamclient.dll), loads that library and asks it for interfaces by
 * version (`CreateInterface`), then pumps its callbacks through the
 * `Steam_*` exports. The client itself -- a process with a browser for a
 * window -- has nothing to add to a game: what the game asks is who is signed
 * in, whether the app is owned, the language, and the callbacks that answer
 * those. They are answered here from what the launcher established with the
 * person's own sign-in (`SteamAccount`): the account and the apps its licences
 * grant. An app the account does not own is not answered as owned.
 *
 * Every export is cdecl; the interfaces are C++ objects whose methods are
 * thiscall (MSVC), laid out in the Steamworks SDK headers' order (objects.js).
 */

import { createSteamObjects } from './objects.js';

/**
 * @typedef {Object} SteamAccount
 * @property {string} steamId     64-bit, decimal.
 * @property {string} accountName
 * @property {string} [personaName]
 * @property {number[]} apps      The app ids the account's licences grant.
 * @property {number} [appId]     The app being run, where the launcher knows it.
 * @property {string} [language]  Steam's name of it: "english".
 * @property {Record<number, Uint8Array>} [ownershipTickets]  Each app's ownership ticket
 *     as Steam signed it for this account (EMsg 858, through the embedder's session):
 *     what ISteamAppTicket hands a game. An app with none -- not owned -- gets none.
 * @property {Record<string, Uint8Array>} [clientFiles]  The Steam client's own DLLs by
 *     name (`steamclient.dll`, `steamclient64.dll`), as Valve distributes them
 *     (`steam/client.js`): data the installed client's files hold, which a program
 *     may open and check; never run. Absent, those files hold the engine's images.
 */

/**
 * @typedef {Object} SteamclientHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate  Memory kept for the run.
 * @property {(name: string, fn: any) => number} register  A handler placed in guest code.
 * @property {(high: number) => void} answerHigh
 * @property {(name: string) => string | null} environment  The process's variable.
 * @property {SteamAccount | null} account
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(text: string) => void} [log]
 * @property {4 | 8} [pointerSize]  8 for steamclient64.dll, a 64-bit process's.
 */

/** k_EUniversePublic. */
const UNIVERSE_PUBLIC = 1;
/** UserStatsReceived_t's callback id and size: game id, result, user. */
const USER_STATS_RECEIVED = 1101;
const USER_STATS_RECEIVED_SIZE = 24;
/**
 * CallbackMsg_t: user, callback id, its data, its size -- the data's pointer
 * eight bytes wide, and the size after it, in a 64-bit process.
 *
 * @param {4 | 8} pointerSize
 */
const callbackMsg = pointerSize=>({ size: pointerSize === 8 ? 24 : 16,
    sizeAt: pointerSize === 8 ? 16 : 12 });
/** A client's ticket for its game's server: bytes enough for what a game passes on. */
const AUTH_TICKET_SIZE = 240;
/** EBeginAuthSessionResult, EAuthSessionResponse. */
const BEGIN_AUTH_OK = 0;
const AUTH_SESSION_OK = 0;
/**
 * ValidateAuthTicketResponse_t: the client, the response, the owner -- the
 * IDs on eight-byte boundaries, as callbacks are packed on Windows.
 */
const VALIDATE_AUTH_TICKET = 143;
const VALIDATE_AUTH_TICKET_SIZE = 24;
/** GSClientApprove_t: the client and its owner. */
const CLIENT_APPROVE = 201;
const CLIENT_APPROVE_SIZE = 16;
/** EUserHasLicenseForAppResult. */
const HAS_LICENSE = 0;
const DOES_NOT_HAVE_LICENSE = 1;
/**
 * SteamAPICallCompleted_t: the call, the callback its result is, the result's
 * size -- what steam_api's call results learn a call finished from.
 */
const API_CALL_COMPLETED = 703;
const API_CALL_COMPLETED_SIZE = 16;
/** ESteamAPICallFailure. */
const CALL_FAILURE_NONE = -1;
const CALL_FAILURE_INVALID_HANDLE = 2;
/** CheckFileSignature_t, and the ECheckFileSignature the client knows: it holds no app's signatures. */
const CHECK_FILE_SIGNATURE = 705;
const NO_SIGNATURES_FOR_THIS_APP = 3;

/**
 * @param {SteamclientHost} host
 */
export function createSteamclientFunctions(host){
    const { account } = host;
    const pointerSize = host.pointerSize ?? 4;
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address @param {string} text @param {number} room  Bytes, the NUL among them. */
    const writeString = (address, text, room)=>{
        if ((address >>> 0) === 0 || room <= 0)
        {
            return;
        }
        const bytes = new TextEncoder().encode(text).subarray(0, room - 1);
        host.writeMemory(address >>> 0, Uint8Array.of(...bytes, 0));
    };

    /** Strings the client hands out, which stay put for as long as the run. */
    const constants = new Map();
    /** @param {string} text */
    const constant = text=>{
        if (!constants.has(text))
        {
            const bytes = new TextEncoder().encode(text);
            const at = host.allocate(bytes.length + 1) >>> 0;
            host.writeMemory(at, Uint8Array.of(...bytes, 0));
            constants.set(text, at);
        }
        return /** @type {number} */ (constants.get(text));
    };

    const steamId = BigInt(account?.steamId ?? 0);
    const language = account?.language ?? 'english';
    /** @param {number} app */
    const owns = app=>(account?.apps ?? []).includes(app >>> 0);
    /**
     * The app running: as the launcher said, else as Steam would have told the
     * process through its environment when it started it.
     */
    const appId = ()=>account?.appId ?? Number(host.environment('SteamAppId')
        ?? host.environment('SteamGameId') ?? 0);

    /**
     * Callbacks waiting for the game to pump them, by the pipe they arrive
     * on -- the user's and a game server's are pumped apart, and steam_api
     * hands each only to the callbacks registered for its side:
     * Steam_BGetCallback hands the oldest out, Steam_FreeLastCallback lets
     * it go.
     *
     * @type {Map<number, { id: number, data: Uint8Array }[]>}
     */
    const pending = new Map();
    /** @param {number} pipe @param {number} id @param {Uint8Array} data */
    const post = (pipe, id, data)=>{
        pending.set(pipe, [...pending.get(pipe) ?? [], { id, data }]);
    };
    /** The pipes made, the first the user's; a game server's is the one CreateLocalUser named. */
    let pipes = 0;
    let serverPipe = 0;
    /** A game server's own ID: an anonymous game server's, in the public universe. */
    const serverId = (1n << 56n) | (4n << 52n) | 1n;
    /** @param {string} version */
    const isServer = version=>version.startsWith('SteamGameServer');

    /**
     * The ticket a client hands the server it connects to. Its contents are
     * opaque to the game, which only passes it on to its own server; the
     * account's Steam ID is in it, for whoever looks.
     *
     * @param {number} buffer @param {number} room
     * @returns {number} its length, 0 when it does not fit
     */
    const writeTicket = (buffer, room)=>{
        const ticket = new Uint8Array(AUTH_TICKET_SIZE);
        const view = new DataView(ticket.buffer);
        view.setUint32(0, AUTH_TICKET_SIZE, true);
        view.setBigUint64(4, steamId, true);
        view.setUint32(12, appId(), true);
        if ((buffer >>> 0) === 0 || room < ticket.length)
        {
            return 0;
        }
        host.writeMemory(buffer >>> 0, ticket);
        return ticket.length;
    };
    /** @type {number} the CallbackMsg_t and data last handed out, until freed */
    let message = 0;

    /**
     * An API call's result, by the SteamAPICall_t the method returned. Every
     * call here completes at once; a game polls IsAPICallCompleted or waits
     * for SteamAPICallCompleted_t, then fetches the result by its callback id.
     * A result is kept for the run rather than dropped once fetched: a game
     * issues a handful, and one polled again after its fetch still answers.
     *
     * @type {Map<bigint, { id: number, data: Uint8Array }>}
     */
    const results = new Map();
    let lastCall = 0n;
    /** @param {number} id @param {Uint8Array} data @returns {bigint} the call */
    const complete = (id, data)=>{
        const call = ++lastCall;
        results.set(call, { id, data });
        const done = new Uint8Array(API_CALL_COMPLETED_SIZE);
        const view = new DataView(done.buffer);
        view.setBigUint64(0, call, true);
        view.setInt32(8, id, true);
        view.setUint32(12, data.length, true);
        post(1, API_CALL_COMPLETED, done);
        return call;
    };
    /** @param {number} low @param {number} high */
    const callOf = (low, high)=>results.get((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0));
    /** @param {number} at @param {boolean} value */
    const writeBool = (at, value)=>{
        if ((at >>> 0) !== 0)
        {
            host.writeMemory(at >>> 0, Uint8Array.of(value ? 1 : 0));
        }
    };
    /**
     * GetAPICallResult's answer: the result copied out when it is the
     * callback asked for and fits, failed otherwise.
     *
     * @param {number[]} args  The call's two halves, out, its size, the callback expected, failed.
     */
    const fetchResult = ([low, high, out, size, expected, failed])=>{
        const result = callOf(low, high);
        const ok = !!result && result.id === expected && result.data.length <= size
            && (out >>> 0) !== 0;
        if (ok)
        {
            host.writeMemory(out >>> 0, result.data);
        }
        writeBool(failed, !ok);
        return ok ? 1 : 0;
    };

    /** Every behaviour by method name, shared by every version that has it. */
    /** @type {Record<string, import('./objects.js').Behaviour>} */
    const behaviours = {
        // ISteamClient
        CreateSteamPipe: ()=>++pipes,
        BReleaseSteamPipe: ()=>1,
        ConnectToGlobalUser: ([pipe])=>pipe,
        // A local user is a game server's: the pipe it is made on is the server's.
        CreateLocalUser: ([pipeOut])=>{
            serverPipe = ++pipes;
            if ((pipeOut >>> 0) !== 0)
            {
                writeDword(pipeOut, serverPipe);
            }
            return serverPipe;
        },
        GetIPCCallCount: ()=>0,
        BShutdownIfAllPipesClosed: ()=>0,
        RunFrame: ()=>0,
        SetWarningMessageHook: ()=>0,
        Set_SteamAPI_CCheckCallbackRegisteredInProcess: ()=>0,
        DestroyAllInterfaces: ()=>0,
        ReleaseUser: ()=>0,

        // ISteamUser, and ISteamGameServer where the names are shared
        GetHSteamUser: ()=>1,
        BLoggedOn: ()=>(account ? 1 : 0),
        GetSteamID: (args, version)=>(isServer(version) ? serverId : steamId),
        // The connection to a game's own server: the ticket it passes on.
        InitiateGameConnection: ([buffer, room])=>writeTicket(buffer, room | 0),
        GetAuthSessionTicket: ([buffer, room, length])=>{
            const written = writeTicket(buffer, room | 0);
            if ((length >>> 0) !== 0)
            {
                writeDword(length, written);
            }
            return written === 0 ? 0 : 1;
        },
        CancelAuthTicket: ()=>0,
        EndAuthSession: ()=>0,
        TerminateGameConnection: ()=>0,
        // A server checking a client's ticket: the signed-in account is who
        // connects, and owns what it runs.
        BeginAuthSession: ([, , low, high], version)=>{
            if (isServer(version))
            {
                const response = new Uint8Array(VALIDATE_AUTH_TICKET_SIZE);
                const view = new DataView(response.buffer);
                view.setUint32(0, low, true);
                view.setUint32(4, high, true);
                view.setUint32(8, AUTH_SESSION_OK, true);
                view.setUint32(16, low, true);
                view.setUint32(20, high, true);
                post(serverPipe, VALIDATE_AUTH_TICKET, response);
            }
            return BEGIN_AUTH_OK;
        },
        SendUserConnectAndAuthenticate: ([, , , out])=>{
            const approve = new Uint8Array(CLIENT_APPROVE_SIZE);
            const view = new DataView(approve.buffer);
            view.setBigUint64(0, steamId, true);
            view.setBigUint64(8, steamId, true);
            post(serverPipe, CLIENT_APPROVE, approve);
            if ((out >>> 0) !== 0)
            {
                const id = new Uint8Array(8);
                new DataView(id.buffer).setBigUint64(0, steamId, true);
                host.writeMemory(out >>> 0, id);
            }
            return 1;
        },
        BSecure: ()=>0,
        InitGameServer: ()=>1,
        LogOnAnonymous: ()=>0,
        LogOn: ()=>0,
        GetPlayerSteamLevel: ()=>1,
        BIsBehindNAT: ()=>0,
        UserHasLicenseForApp: ([, , app])=>(owns(app) ? HAS_LICENSE : DOES_NOT_HAVE_LICENSE),
        GetUserDataFolder: ([buffer, size])=>{
            writeString(buffer, `C:\\Program Files (x86)\\Steam\\userdata\\${
                Number(steamId & 0xffffffffn)}\\${appId()}\\local`, size | 0);
            return 1;
        },

        // ISteamAppTicket: the ownership ticket Steam signed, whole, and where in
        // it the app id, the Steam ID and the signature are (the ticket's first
        // dword is the length the signature follows). None for an app the
        // account was given no ticket for, as Steam has none for one it does
        // not own; none either into a buffer too small.
        GetAppOwnershipTicketData: ([app, buffer, size, appAt, steamIdAt, signatureAt,
            signatureSize])=>{
            const ticket = account?.ownershipTickets?.[app >>> 0];
            if (!ticket || ticket.length < 24 || (buffer >>> 0) === 0
                || (size >>> 0) < ticket.length)
            {
                return 0;
            }
            const signed = new DataView(ticket.buffer, ticket.byteOffset, 4).getUint32(0, true);
            host.writeMemory(buffer >>> 0, ticket);
            for (const [out, value] of /** @type {const} */ ([[appAt, 16], [steamIdAt, 8],
                [signatureAt, signed], [signatureSize, ticket.length - signed]]))
            {
                if ((out >>> 0) !== 0)
                {
                    writeDword(out, value);
                }
            }
            return ticket.length;
        },

        // ISteamApps
        BIsSubscribed: ()=>(owns(appId()) ? 1 : 0),
        BIsSubscribedApp: ([app])=>(owns(app) ? 1 : 0),
        BIsAppInstalled: ([app])=>(owns(app) ? 1 : 0),
        BIsDlcInstalled: ([app])=>(owns(app) ? 1 : 0),
        BIsLowViolence: ()=>0,
        BIsCybercafe: ()=>0,
        BIsVACBanned: ()=>0,
        BIsSubscribedFromFreeWeekend: ()=>0,
        BIsSubscribedFromFamilySharing: ()=>0,
        GetDLCCount: ()=>0,
        GetCurrentGameLanguage: ()=>constant(language),
        GetAvailableGameLanguages: ()=>constant(language),
        GetAppOwner: ()=>steamId,
        GetCurrentBetaName: ()=>0,
        GetAppBuildId: ()=>0,
        GetLaunchQueryParam: ()=>constant(''),

        // ISteamUtils
        GetAppID: ()=>appId(),
        GetConnectedUniverse: ()=>UNIVERSE_PUBLIC,
        GetServerRealTime: ()=>Math.floor(Date.now() / 1000),
        GetIPCountry: ()=>constant('US'),
        GetSecondsSinceAppActive: ()=>0,
        GetSecondsSinceComputerActive: ()=>0,
        GetCurrentBatteryPower: ()=>255,
        IsOverlayEnabled: ()=>0,
        BOverlayNeedsPresent: ()=>0,
        IsSteamRunningInVR: ()=>0,
        IsSteamInBigPictureMode: ()=>0,
        IsSteamChinaLauncher: ()=>0,
        GetSteamUILanguage: ()=>constant(language),
        IsAPICallCompleted: ([low, high, failed])=>{
            const known = !!callOf(low, high);
            writeBool(failed, !known);
            return known ? 1 : 0;
        },
        GetAPICallFailureReason: ([low, high])=>(callOf(low, high)
            ? CALL_FAILURE_NONE : CALL_FAILURE_INVALID_HANDLE),
        GetAPICallResult: fetchResult,
        CheckFileSignature: ()=>complete(CHECK_FILE_SIGNATURE,
            new Uint8Array(Uint32Array.of(NO_SIGNATURES_FOR_THIS_APP).buffer)),

        // ISteamFriends
        GetPersonaName: ()=>constant(account?.personaName ?? account?.accountName ?? ''),
        GetPersonaState: ()=>1,
        GetFriendCount: ()=>0,
        GetClanCount: ()=>0,
        GetFriendPersonaName: ()=>constant(''),

        // ISteamUserStats: the stats are there as soon as they are asked for,
        // and none is set.
        RequestCurrentStats: ()=>{
            const data = new Uint8Array(USER_STATS_RECEIVED_SIZE);
            const view = new DataView(data.buffer);
            view.setBigUint64(0, BigInt(appId()), true);
            view.setUint32(8, 1, true);
            view.setBigUint64(16, steamId, true);
            post(1, USER_STATS_RECEIVED, data);
            return 1;
        },
        GetAchievement: ([, achieved])=>{
            if ((achieved >>> 0) !== 0)
            {
                host.writeMemory(achieved >>> 0, Uint8Array.of(0));
            }
            return 1;
        },
        StoreStats: ()=>1,
        SetAchievement: ()=>1,
        ClearAchievement: ()=>1,
        GetNumAchievements: ()=>0,
    };

    const objects = createSteamObjects({ register: host.register, allocate: host.allocate,
        writeMemory: host.writeMemory, answerHigh: host.answerHigh, divergence: host.divergence,
        pointerSize }, behaviours);

    // A version is asked for by its string, the last argument of every
    // GetISteam* call.
    /** @param {number[]} args */
    const byVersion = args=>{
        const version = host.readCString((args.at(-1) ?? 0) >>> 0, 128);
        const object = objects.objectFor(version);
        host.log?.(`${version}: ${object === 0 ? 'none' : `0x${object.toString(16)}`}`);
        return object;
    };
    for (const name of ['GetISteamUser', 'GetISteamGameServer', 'GetISteamFriends',
        'GetISteamUtils', 'GetISteamMatchmaking', 'GetISteamMatchmakingServers',
        'GetISteamGenericInterface', 'GetISteamUserStats', 'GetISteamGameServerStats',
        'GetISteamApps', 'GetISteamNetworking', 'GetISteamRemoteStorage', 'GetISteamScreenshots',
        'GetISteamGameSearch', 'GetISteamHTTP', 'GetISteamUnifiedMessages',
        'DEPRECATED_GetISteamUnifiedMessages', 'GetISteamController', 'GetISteamUGC',
        'GetISteamAppList', 'GetISteamMusic', 'GetISteamMusicRemote', 'GetISteamHTMLSurface',
        'GetISteamInventory', 'GetISteamVideo', 'GetISteamParentalSettings', 'GetISteamInput',
        'GetISteamParties', 'GetISteamRemotePlay'])
    {
        behaviours[name] = byVersion;
    }

    /**
     * @param {number} argBytes @param {(args: number[]) => number | void} [handler]
     * @param {number[]} [quadwords]  The eight-byte arguments, by first dword:
     *     one slot each to an x86-64 caller.
     */
    const cdecl = (argBytes, handler = ()=>0, quadwords)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'), argBytes,
        handler: (/** @type {number[]} */ args)=>handler(args) ?? 0,
        ...quadwords ? { quadwords } : {},
    });

    return {
        /**
         * void* CreateInterface(const char* version, int* returnCode)
         *
         * The return code is 0 for an interface there is, 1 for none.
         */
        CreateInterface: cdecl(8, ([name, code])=>{
            const version = host.readCString(name >>> 0, 128);
            const object = account ? objects.objectFor(version) : 0;
            host.log?.(`CreateInterface ${version}: ${object === 0 ? 'none'
                : `0x${object.toString(16)}`}`);
            if ((code >>> 0) !== 0)
            {
                writeDword(code >>> 0, object === 0 ? 1 : 0);
            }
            return object;
        }),

        /**
         * bool Steam_BGetCallback(HSteamPipe, CallbackMsg_t*, HSteamCall*)
         *
         * The oldest callback waiting, in memory that stays until it is freed.
         */
        Steam_BGetCallback: cdecl(12, ([pipe, out])=>{
            const next = pending.get(pipe)?.shift();
            if (!next || (out >>> 0) === 0)
            {
                return 0;
            }
            message = host.allocate(next.data.length) >>> 0;
            host.writeMemory(message, next.data);
            const layout = callbackMsg(pointerSize);
            const record = new Uint8Array(layout.size);
            const view = new DataView(record.buffer);
            view.setUint32(0, pipe, true);
            view.setInt32(4, next.id, true);
            view.setUint32(8, message, true);
            view.setInt32(layout.sizeAt, next.data.length, true);
            host.writeMemory(out >>> 0, record);
            return 1;
        }),
        /** void Steam_FreeLastCallback(HSteamPipe) */
        Steam_FreeLastCallback: cdecl(4, ()=>{
            message = 0;
        }),
        /**
         * bool Steam_GetAPICallResult(HSteamPipe, SteamAPICall_t, void* callback,
         *     int size, int expected, bool* failed)
         */
        Steam_GetAPICallResult: cdecl(28, ([, ...args])=>fetchResult(args), [1]),
        /** void Steam_ReleaseThreadLocalMemory(bool threadExit) */
        Steam_ReleaseThreadLocalMemory: cdecl(4),
        /** HSteamUser Steam_GetHSteamUserCurrent(void) */
        Steam_GetHSteamUserCurrent: cdecl(0, ()=>(account ? 1 : 0)),
        /** void Steam_RegisterInterfaceFuncs(void* module) */
        Steam_RegisterInterfaceFuncs: cdecl(4),
        /** void Steam_RunCallbacks(HSteamPipe, bool gameServer) */
        Steam_RunCallbacks: cdecl(8),
        /** void Steam_SetMinidumpSteamID(uint64) */
        Steam_SetMinidumpSteamID: cdecl(8, undefined, [0]),

        // The crash reporter's: there is nobody to report to.
        Breakpad_SteamMiniDumpInit: cdecl(12),
        Breakpad_SteamSetAppID: cdecl(4),
        Breakpad_SteamSetSteamID: cdecl(8, undefined, [0]),
        Breakpad_SteamWriteMiniDumpSetComment: cdecl(4),
        Breakpad_SteamWriteMiniDumpUsingExceptionInfoWithBuildId: cdecl(8),
    };
}

const HKEY_CURRENT_USER = 0x80000001;
const REG_SZ = 1;
const REG_DWORD = 4;

/** Where the client's files are, as an installed Steam's registry says. */
export const STEAM_PATH = 'C:\\Program Files (x86)\\Steam';

/**
 * The client library a process of this width loads, as `ActiveProcess` names it.
 *
 * @param {number} pointerSize
 */
export const steamClientDll = pointerSize=>(pointerSize === 8
    ? 'steamclient64.dll' : 'steamclient.dll');

/**
 * Tells the registry a client is running, as Steam does while it runs: its
 * pid and the library a game loads (`ActiveProcess`), its directory, and the
 * account signed in (`ActiveUser`, the account id: the low half of the Steam
 * ID).
 *
 * @param {any} hive  The registry service (`registry-service.js`).
 * @param {{ pid: number, account: SteamAccount }} running
 */
export function announceSteamClient(hive, { pid, account }){
    // The hive keeps a string narrow, as RegSetValueExA hands it over.
    /** @param {string} text */
    const sz = text=>Uint8Array.from([...text, '\0'], character=>character.charCodeAt(0) & 0xff);
    /** @param {number} value */
    const dword = value=>new Uint8Array(Uint32Array.of(value >>> 0).buffer);
    const user = hive.root(HKEY_CURRENT_USER);
    const { key: steam } = hive.create(user, 'Software\\Valve\\Steam');
    // Written as Steam writes them: forward slashes, lower case.
    const slashed = (/** @type {string} */ path)=>path.replaceAll('\\', '/').toLowerCase();
    hive.setValue(steam, 'SteamPath', REG_SZ, sz(slashed(STEAM_PATH)));
    hive.setValue(steam, 'SteamExe', REG_SZ, sz(slashed(`${STEAM_PATH}\\steam.exe`)));
    hive.setValue(steam, 'Language', REG_SZ, sz(account.language ?? 'english'));
    const { key: active } = hive.create(user, 'Software\\Valve\\Steam\\ActiveProcess');
    hive.setValue(active, 'pid', REG_DWORD, dword(pid));
    hive.setValue(active, 'SteamClientDll', REG_SZ, sz(`${STEAM_PATH}\\${steamClientDll(4)}`));
    hive.setValue(active, 'SteamClientDll64', REG_SZ, sz(`${STEAM_PATH}\\${steamClientDll(8)}`));
    hive.setValue(active, 'ActiveUser', REG_DWORD,
        dword(Number(BigInt(account.steamId) & 0xffffffffn)));
}
