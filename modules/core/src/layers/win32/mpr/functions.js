/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mpr — the network provider router, behind which this machine has no network.
 *
 * An installer asks whether a drive letter is a mapped network share before
 * it writes there. Every drive here is local, so the answer is the one a
 * real machine gives for a local drive: the device is not a redirected one.
 * Declared so the call pops what it was pushed.
 */

/** ERROR_NOT_CONNECTED: the device is not a redirected network resource. */
const ERROR_NOT_CONNECTED = 2250;
/** ERROR_NO_NETWORK: there is no provider to ask who the network user is. */
const ERROR_NO_NETWORK = 1222;

/**
 * @typedef {Object} NetworkHost
 * @property {(code: number) => void} [setLastError]
 */

/**
 * @param {NetworkHost} host
 */
export function createNetworkFunctions(host){
    return {
        /**
         * DWORD WNetGetConnectionA(LPCSTR lpLocalName, LPSTR lpRemoteName, LPDWORD lpnLength)
         *
         * The error is the return value, and the last error too, since a
         * caller of the era reads whichever it prefers.
         */
        WNetGetConnectionA: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError?.(ERROR_NOT_CONNECTED);
                return ERROR_NOT_CONNECTED;
            },
        },

        /**
         * DWORD WNetGetUserA(LPCSTR lpName, LPSTR lpUserName, LPDWORD lpnLength)
         *
         * A network user is the provider's to name, and there is none.
         */
        WNetGetUserA: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError?.(ERROR_NO_NETWORK);
                return ERROR_NO_NETWORK;
            },
        },
    };
}
