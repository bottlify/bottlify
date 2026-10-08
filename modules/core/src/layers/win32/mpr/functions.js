/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mpr -- the network provider router, behind which this machine has no network.
 *
 * An installer asks whether a drive letter is a mapped network share before
 * it writes there, and walks the connections to find one. Every drive here is
 * local and nothing is connected or remembered, so the answers are the ones a
 * real machine gives for a local drive and an empty connection list: the
 * device is not a redirected one, and an enumeration runs out at once. What
 * only a network can answer -- the machines of the workgroup, the user a
 * provider knows -- answers that there is no network.
 *
 * Each call answers its error as its return value and as the last error too,
 * since a caller of the era reads whichever it prefers. Declared so each call
 * pops what it was pushed.
 */

/** NO_ERROR: the enumeration is open, or closed. */
const NO_ERROR = 0;
/** WN_BAD_HANDLE: not an enumeration this library opened, or one already closed. */
const ERROR_INVALID_HANDLE = 6;
/** WN_BAD_VALUE: a scope or a resource type no enumeration has. */
const ERROR_INVALID_PARAMETER = 87;
/** WN_BAD_LEVEL: an information level WNetGetUniversalName does not have. */
const ERROR_INVALID_LEVEL = 124;
/** WN_NO_MORE_ENTRIES: an enumeration has nothing (more) to give. */
const ERROR_NO_MORE_ITEMS = 259;
/** WN_BAD_POINTER: nowhere to put the answer. */
const ERROR_INVALID_ADDRESS = 487;
/** ERROR_NO_NETWORK: there is no provider to ask who the network user is. */
const ERROR_NO_NETWORK = 1222;
/** ERROR_NOT_CONNECTED: the device is not a redirected network resource. */
const ERROR_NOT_CONNECTED = 2250;

/** The scopes WNetOpenEnum takes. */
const RESOURCE_CONNECTED = 1;
const RESOURCE_GLOBALNET = 2;
const RESOURCE_REMEMBERED = 3;
const RESOURCE_CONTEXT = 5;
/** RESOURCETYPE_DISK | RESOURCETYPE_PRINT; RESOURCETYPE_ANY is none of them. */
const RESOURCE_TYPES = 0x3;

/** The two levels WNetGetUniversalName answers in. */
const UNIVERSAL_NAME_INFO_LEVEL = 1;
const REMOTE_NAME_INFO_LEVEL = 2;

/**
 * The first enumeration handle, and the step between two. An enumeration
 * handle is the router's own and not the kernel's -- CloseHandle does not close
 * one -- so it is numbered apart from the kernel's handles, and a closed one is
 * never handed out again: a stale handle lands on nothing.
 */
const FIRST_ENUMERATION = 0x4d500004;
const ENUMERATION_STRIDE = 4;

/**
 * @typedef {Object} NetworkHost
 * @property {(code: number) => void} [setLastError]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 *           Where WNetOpenEnum puts the handle. Without it no enumeration can
 *           be handed out, and every one answers as a machine with no network
 *           provider installed does: there is no network.
 */

/**
 * @param {NetworkHost} host
 */
export function createNetworkFunctions(host){
    /** The enumerations open, by handle. @type {Set<number>} */
    const enumerations = new Set();
    let nextEnumeration = FIRST_ENUMERATION;

    /** @param {number} code */
    const answer = code=>{
        host.setLastError?.(code);
        return code;
    };

    /**
     * DWORD WNetGetConnection(LPCTSTR lpLocalName, LPTSTR lpRemoteName, LPDWORD lpnLength)
     *
     * Every device is local; the name is not read, in either form.
     */
    const getConnection = {
        argBytes: 12,
        handler: ()=>answer(ERROR_NOT_CONNECTED),
    };

    /**
     * DWORD WNetOpenEnum(DWORD dwScope, DWORD dwType, DWORD dwUsage,
     *   LPNETRESOURCE lpNetResource, LPHANDLE lphEnum)
     *
     * The connections and the remembered connections are lists this machine
     * has, and both are empty: the enumeration opens, and its first read runs
     * out. The network and the workgroup's context are only there with a
     * network. The usage and the container are read only for the network,
     * which is not there, so neither is read at all; NETRESOURCE is the one
     * place the A and W forms differ, and the two share this body.
     */
    const openEnum = {
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([scope, type, , , out])=>{
            if ((out >>> 0) === 0)
            {
                return answer(ERROR_INVALID_ADDRESS);
            }
            if ((type & ~RESOURCE_TYPES) !== 0)
            {
                return answer(ERROR_INVALID_PARAMETER);
            }
            switch (scope >>> 0)
            {
                case RESOURCE_CONNECTED:
                case RESOURCE_REMEMBERED:
                    break;
                case RESOURCE_GLOBALNET:
                case RESOURCE_CONTEXT:
                    return answer(ERROR_NO_NETWORK);
                default:
                    return answer(ERROR_INVALID_PARAMETER);
            }
            if (!host.writeMemory)
            {
                return answer(ERROR_NO_NETWORK);
            }
            const handle = nextEnumeration;
            nextEnumeration += ENUMERATION_STRIDE;
            enumerations.add(handle);
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, handle, true);
            host.writeMemory(out >>> 0, bytes);
            return NO_ERROR;
        },
    };

    /**
     * DWORD WNetEnumResource(HANDLE hEnum, LPDWORD lpcCount, LPVOID lpBuffer,
     *   LPDWORD lpBufferSize)
     *
     * Every list this machine opens is empty, so there is never an entry to
     * write and the count and size are left as the caller set them.
     */
    const enumResource = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([handle, count, , size])=>{
            if (!enumerations.has(handle >>> 0))
            {
                return answer(ERROR_INVALID_HANDLE);
            }
            if ((count >>> 0) === 0 || (size >>> 0) === 0)
            {
                return answer(ERROR_INVALID_ADDRESS);
            }
            return answer(ERROR_NO_MORE_ITEMS);
        },
    };

    /**
     * DWORD WNetGetUniversalName(LPCTSTR lpLocalPath, DWORD dwInfoLevel,
     *   LPVOID lpBuffer, LPDWORD lpBufferSize)
     *
     * A path on a local drive has no network name, at either level: the size
     * is left alone and nothing is written, which is what Windows' own tests
     * see for every drive that is not a remote one.
     */
    const getUniversalName = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([path, level, , size])=>{
            if ((level >>> 0) !== UNIVERSAL_NAME_INFO_LEVEL
                && (level >>> 0) !== REMOTE_NAME_INFO_LEVEL)
            {
                return answer(ERROR_INVALID_LEVEL);
            }
            if ((path >>> 0) === 0 || (size >>> 0) === 0)
            {
                return answer(ERROR_INVALID_ADDRESS);
            }
            return answer(ERROR_NOT_CONNECTED);
        },
    };

    return {
        WNetGetConnectionA: getConnection,
        WNetGetConnectionW: getConnection,

        /**
         * DWORD WNetGetUserA(LPCSTR lpName, LPSTR lpUserName, LPDWORD lpnLength)
         *
         * A network user is the provider's to name, and there is none.
         */
        WNetGetUserA: {
            argBytes: 12,
            handler: ()=>answer(ERROR_NO_NETWORK),
        },

        WNetOpenEnumA: openEnum,
        WNetOpenEnumW: openEnum,
        WNetEnumResourceA: enumResource,
        WNetEnumResourceW: enumResource,

        /**
         * DWORD WNetCloseEnum(HANDLE hEnum)
         *
         * Closed once; a second close is a handle that is no longer one.
         */
        WNetCloseEnum: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(enumerations.delete(handle >>> 0) ? NO_ERROR
                : answer(ERROR_INVALID_HANDLE)),
        },

        WNetGetUniversalNameA: getUniversalName,
        WNetGetUniversalNameW: getUniversalName,

        /**
         * DWORD WNetCancelConnectionA(LPCSTR lpName, BOOL fForce)
         *
         * Nothing is connected, so whatever is named -- a drive letter or a
         * share -- is not a connection to cancel.
         */
        WNetCancelConnectionA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name])=>answer((name >>> 0) === 0 ? ERROR_INVALID_ADDRESS
                : ERROR_NOT_CONNECTED),
        },

        /**
         * DWORD WNetUseConnectionA(HWND, LPNETRESOURCEA lpNetResource,
         *   LPCSTR lpPassword, LPCSTR lpUserId, DWORD dwFlags, LPSTR lpAccessName,
         *   LPDWORD lpBufferSize, LPDWORD lpResult)
         *
         * Making a connection is a provider's work, and there is no provider.
         */
        WNetUseConnectionA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, resource])=>answer((resource >>> 0) === 0 ? ERROR_INVALID_ADDRESS
                : ERROR_NO_NETWORK),
        },

        /**
         * DWORD WNetConnectionDialog(HWND hwnd, DWORD dwType)
         *
         * The dialog browses what the providers offer, and with none it is not
         * shown: there is no network, rather than a dialog the user cancelled.
         * A type that is neither disk nor print is refused first.
         */
        WNetConnectionDialog: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, type])=>answer((type >>> 0) === 0 || ((type >>> 0) & ~RESOURCE_TYPES) !== 0
                ? ERROR_INVALID_PARAMETER : ERROR_NO_NETWORK),
        },

        /**
         * DWORD WNetRestoreConnectionW(HWND hwndParent, LPCWSTR lpDevice)
         *
         * Restoring a remembered connection asks its provider to make it
         * again; with no provider there is no network to restore it on.
         */
        WNetRestoreConnectionW: {
            argBytes: 8,
            handler: ()=>answer(ERROR_NO_NETWORK),
        },
    };
}
