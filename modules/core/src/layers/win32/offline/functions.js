/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * netapi32's NetBIOS, tapi32 and SensApi -- the libraries a program links to
 * ask about network adapters, modems and connectivity, on a machine that has
 * none of them.
 *
 * A game of this era links all three for its online and modem modes and asks
 * them once at start-up; a library missing from the system stops it loading at
 * all. Each answers what a real machine without that hardware answers: NetBIOS
 * enumerates no adapters and refuses every other command with "invalid adapter
 * number", TAPI initialises with no line devices and refuses any device or line
 * it is given, and the network is not alive. Declared so each call pops what it
 * was pushed.
 */

/** NCB fields: the command, its return code and its completion code; the buffer and its length. */
const NCB_COMMAND = 0;
const NCB_RETCODE = 1;
const NCB_BUFFER = 4;
const NCB_LENGTH = 8;
const NCB_CMD_CPLT = 49;
const NCBENUM = 0x37;
const ASYNCH = 0x80;
const NRC_GOODRET = 0x00;
const NRC_BUFLEN = 0x01;
const NRC_BRIDGE = 0x23;

const LINEERR_BADDEVICEID = 0x80000002;
const LINEERR_INVALAPPHANDLE = 0x80000015;
const LINEERR_INVALCALLHANDLE = 0x80000018;
const LINEERR_INVALLINEHANDLE = 0x8000002b;
const LINEERR_INVALPOINTER = 0x80000035;

/**
 * @typedef {Object} OfflineHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [setLastError]
 */

/** @param {number} value */
const u32 = value=>new Uint8Array(new Uint32Array([value >>> 0]).buffer);

/** @param {OfflineHost} host */
export function createNetbiosFunctions(host){
    return {
        /**
         * UCHAR Netbios(PNCB pncb)
         *
         * NCBENUM lists the adapters: a LANA_ENUM whose count is 0. Every
         * other command names an adapter, and none is there. The answer goes
         * into the NCB's return and completion codes as well, which is where
         * a caller polling an asynchronous command reads it.
         */
        Netbios: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([ncb])=>{
                const at = ncb >>> 0;
                if (at === 0)
                {
                    return NRC_BRIDGE;
                }
                const head = host.readMemory(at, NCB_LENGTH + 2);
                const command = head[NCB_COMMAND] & ~ASYNCH;
                let code = NRC_BRIDGE;
                if (command === NCBENUM)
                {
                    const buffer = new DataView(head.buffer, head.byteOffset)
                        .getUint32(NCB_BUFFER, true);
                    const length = head[NCB_LENGTH] | head[NCB_LENGTH + 1] << 8;
                    code = buffer && length ? NRC_GOODRET : NRC_BUFLEN;
                    if (code === NRC_GOODRET)
                    {
                        host.writeMemory(buffer, new Uint8Array([0]));
                    }
                }
                host.writeMemory(at + NCB_RETCODE, new Uint8Array([code]));
                host.writeMemory(at + NCB_CMD_CPLT, new Uint8Array([code]));
                return code;
            },
        },
    };
}

/** @param {OfflineHost} host */
export function createTelephonyFunctions(host){
    /** The application handles lineInitialize gave and lineShutdown has not taken back. */
    const apps = new Set();
    let nextApp = 0x7a900004;

    /** @param {number} argBytes @param {number} error */
    const refuse = (argBytes, error)=>({ argBytes, handler: ()=>error });
    /** @param {number} argBytes */
    const device = argBytes=>({
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [app])=>apps.has(app >>> 0)
            ? LINEERR_BADDEVICEID : LINEERR_INVALAPPHANDLE,
    });

    return {
        /**
         * LONG lineInitialize(LPHLINEAPP lphLineApp, HINSTANCE hInstance,
         *   LINECALLBACK lpfnCallback, LPCSTR lpszAppName, LPDWORD lpdwNumDevs)
         */
        lineInitialize: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, , , , count])=>{
                if ((out >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return LINEERR_INVALPOINTER;
                }
                const app = nextApp;
                nextApp += 4;
                apps.add(app);
                host.writeMemory(out >>> 0, u32(app));
                host.writeMemory(count >>> 0, u32(0));
                return 0;
            },
        },
        /** LONG lineShutdown(HLINEAPP hLineApp) */
        lineShutdown: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([app])=>apps.delete(app >>> 0) ? 0 : LINEERR_INVALAPPHANDLE,
        },
        /** LONG lineNegotiateAPIVersion(hLineApp, dwDeviceID, dwAPILowVersion, dwAPIHighVersion, lpdwAPIVersion, lpExtensionID) */
        lineNegotiateAPIVersion: device(24),
        /** LONG lineGetDevCaps(hLineApp, dwDeviceID, dwAPIVersion, dwExtVersion, lpLineDevCaps) */
        lineGetDevCaps: device(20),
        /** LONG lineOpen(hLineApp, dwDeviceID, lphLine, dwAPIVersion, dwExtVersion, dwCallbackInstance, dwPrivileges, dwMediaModes, lpCallParams) */
        lineOpen: device(36),
        /** LONG lineClose(HLINE hLine) -- no line was ever opened. */
        lineClose: refuse(4, LINEERR_INVALLINEHANDLE),
        /** LONG lineMakeCall(hLine, lphCall, lpszDestAddress, dwCountryCode, lpCallParams) */
        lineMakeCall: refuse(20, LINEERR_INVALLINEHANDLE),
        /** LONG lineGetID(hLine, dwAddressID, hCall, dwSelect, lpDeviceID, lpszDeviceClass) */
        lineGetID: refuse(24, LINEERR_INVALLINEHANDLE),
        /** LONG lineAnswer(HCALL hCall, LPCSTR lpsUserUserInfo, DWORD dwSize) */
        lineAnswer: refuse(12, LINEERR_INVALCALLHANDLE),
    };
}

/** @param {OfflineHost} host */
export function createSensFunctions(host){
    return {
        /**
         * BOOL IsNetworkAlive(LPDWORD lpdwFlags)
         *
         * FALSE with a last error of 0 is the documented answer for "no
         * connectivity", as opposed to a failure to find out.
         */
        IsNetworkAlive: {
            argBytes: 4,
            handler: ()=>{
                host.setLastError?.(0);
                return 0;
            },
        },
    };
}
