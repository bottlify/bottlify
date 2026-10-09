/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dplayx — DirectPlay: the session object, the service-provider list and the
 * lobby a matchmaking client launches a program through.
 *
 * This machine installs no DirectPlay service provider, so the provider list
 * is empty and a session object cannot be made (DPERR_UNAVAILABLE, as for a
 * provider GUID that is not installed). The lobby object is made, because a
 * program asks it at start-up whether a lobby client launched it; it was not,
 * and the lobby answers DPERR_NOTLOBBIED, which the program takes as "start
 * normally". The library is linked by number: its header gives no names in
 * the import table of a program built against the DirectX SDK.
 */

import { createComObject } from '../ole32/objects.js';

/** dplay.h: MAKE_HRESULT(1, _FACDP = 0x877, code). */
const dpError = (/** @type {number} */ code)=>(0x88770000 | code) >>> 0;
export const DP_OK = 0;
export const DPERR_UNAVAILABLE = dpError(500);
export const DPERR_NOTLOBBIED = dpError(1010);
export const DPERR_INVALIDPARAMS = 0x80070057;
export const DPERR_UNSUPPORTED = 0x80004001;

/** The numbers dplayx.dll exports these at; a program imports them so. */
export const DPLAYX_ORDINALS = Object.freeze({
    1: 'DirectPlayCreate',
    2: 'DirectPlayEnumerateA',
    3: 'DirectPlayEnumerateW',
    4: 'DirectPlayLobbyCreateA',
    5: 'DirectPlayLobbyCreateW',
    9: 'DirectPlayEnumerate',
});

/** dplobby.h: every revision of IDirectPlayLobby, ANSI and wide. */
export const LOBBY_INTERFACES = Object.freeze([
    '{AF465C71-9588-11CF-A020-00AA006157AC}', // IDirectPlayLobby
    '{26C66A70-B367-11CF-A024-00AA006157AC}', // IDirectPlayLobbyA
    '{0194C220-A303-11D0-9C4F-00A0C905425E}', // IDirectPlayLobby2
    '{1BB4AF80-A303-11D0-9C4F-00A0C905425E}', // IDirectPlayLobby2A
    '{2DB72490-652C-11D1-A7A8-0000F803ABFC}', // IDirectPlayLobby3
    '{2DB72491-652C-11D1-A7A8-0000F803ABFC}', // IDirectPlayLobby3A
]);

/**
 * IDirectPlayLobby3's methods after IUnknown, in vtable order; the earlier
 * revisions are prefixes of it (1: 11 methods, 2: 12).
 *
 * @type {ReadonlyArray<[string, number, number]>}  name, argBytes, answer
 */
const LOBBY_METHODS = [
    // Connect(flags, IDirectPlay2 **, IUnknown *): there is no lobby
    // session to join.
    ['Connect', 16, DPERR_NOTLOBBIED],
    ['CreateAddress', 28, DPERR_UNSUPPORTED],
    ['EnumAddress', 20, DPERR_UNSUPPORTED],
    // No provider, so no address types and no registered applications:
    // the enumeration ends without calling back.
    ['EnumAddressTypes', 20, DP_OK],
    ['EnumLocalApplications', 16, DP_OK],
    // GetConnectionSettings(appId, data, size *): the program was not
    // launched by a lobby client.
    ['GetConnectionSettings', 16, DPERR_NOTLOBBIED],
    ['ReceiveLobbyMessage', 24, DPERR_NOTLOBBIED],
    ['RunApplication', 20, DPERR_UNSUPPORTED],
    ['SendLobbyMessage', 20, DPERR_NOTLOBBIED],
    ['SetConnectionSettings', 16, DPERR_NOTLOBBIED],
    ['SetLobbyMessageEvent', 16, DPERR_NOTLOBBIED],
    ['CreateCompoundAddress', 20, DPERR_UNSUPPORTED],
    ['ConnectEx', 20, DPERR_NOTLOBBIED],
    ['RegisterApplication', 12, DPERR_UNSUPPORTED],
    ['UnregisterApplication', 12, DPERR_UNSUPPORTED],
    ['WaitForConnectionSettings', 8, DPERR_NOTLOBBIED],
];

/** @param {number} revision */
const lobbyMethods = revision=>LOBBY_METHODS
    .slice(0, revision === 1 ? 11 : revision === 2 ? 12 : LOBBY_METHODS.length)
    .map(([name, argBytes, answer])=>({ name, argBytes, invoke: ()=>answer }));

/**
 * @typedef {Object} DplayHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ publish: (object: import('../ole32/objects.js').ComObject,
 *             interfaceId: string) => number }} vtables
 */

/**
 * @param {DplayHost} host
 */
export function createDplayFunctions(host){
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * HRESULT DirectPlayLobbyCreateA(LPGUID lpGUIDDSP, LPDIRECTPLAYLOBBYA *lplpDPL,
     *                                IUnknown *lpUnk, LPVOID lpData, DWORD dwDataSize)
     *
     * The out pointer gets IDirectPlayLobby(A); the later revisions are
     * reached through QueryInterface. lpUnk is for aggregation, which
     * DirectPlay does not support.
     */
    const lobbyCreate = (/** @type {boolean} */ wide)=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([, out, outer])=>{
            if ((out >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            writeU32(out, 0);
            if ((outer >>> 0) !== 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            const object = createComObject('{2FE8F810-B2A5-11D0-A787-0000F803ABFC}', {
                interfaces: LOBBY_INTERFACES.map((id, index)=>({
                    id, methods: lobbyMethods(1 + (index >> 1)),
                })),
            });
            const pointer = host.vtables.publish(object, LOBBY_INTERFACES[wide ? 0 : 1]) >>> 0;
            writeU32(out, pointer);
            return pointer === 0 ? 0x8007000e : DP_OK;
        },
    });

    /**
     * HRESULT DirectPlayEnumerateA(LPDPENUMDPCALLBACKA lpEnumCallback, LPVOID lpContext)
     *
     * One callback per installed service provider: there are none.
     */
    const enumerate = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([callback])=>((callback >>> 0) === 0 ? DPERR_INVALIDPARAMS : DP_OK),
    };

    return {
        /**
         * HRESULT DirectPlayCreate(LPGUID lpGUIDSP, LPDIRECTPLAY *lplpDP, IUnknown *pUnk)
         *
         * A session object is made over a service provider, and no provider
         * is installed; the out pointer is cleared so a caller that checks it
         * rather than the HRESULT sees nothing made.
         */
        DirectPlayCreate: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, out])=>{
                if ((out >>> 0) !== 0)
                {
                    writeU32(out, 0);
                }
                return (guid >>> 0) === 0 || (out >>> 0) === 0
                    ? DPERR_INVALIDPARAMS
                    : DPERR_UNAVAILABLE;
            },
        },
        DirectPlayEnumerateA: enumerate,
        DirectPlayEnumerateW: enumerate,
        DirectPlayEnumerate: enumerate,
        DirectPlayLobbyCreateA: lobbyCreate(false),
        DirectPlayLobbyCreateW: lobbyCreate(true),
    };
}
