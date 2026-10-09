/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msvfw32 — Video for Windows: the installable-compressor manager (ICM) and
 * the MCIWnd window class that plays a clip through MCI.
 *
 * This machine installs no VfW compressors and has no MCI video device, so
 * the compressor list is empty and an MCIWnd is never made: enumeration ends
 * at its first index and creation answers NULL, the documented failure, which
 * a program that plays a film through MCIWnd takes as "no film to play". A
 * program linked against the library at load time only needs it present and
 * answering so.
 */

/** sizeof(ICINFO): dwSize … szDriver[128] (WCHAR). */
export const ICINFO_SIZE = 568;

/** ICERR_BADHANDLE, (LRESULT)-8. */
const ICERR_BADHANDLE = 0xfffffff8;

/**
 * @typedef {Object} MsvfwHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {MsvfwHost} host
 */
export function createMsvfwFunctions(host){
    return {
        /**
         * BOOL ICInfo(DWORD fccType, DWORD fccHandler, ICINFO *lpicinfo)
         *
         * fccHandler is an index when enumerating and a FOURCC when asking
         * about one compressor; with none installed either way finds nothing.
         * The structure is cleared but for dwSize, so a caller that reads it
         * after a FALSE sees no stale driver name.
         */
        ICInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , info])=>{
                if ((info >>> 0) !== 0)
                {
                    const bytes = new Uint8Array(ICINFO_SIZE);
                    new DataView(bytes.buffer).setUint32(0, ICINFO_SIZE, true);
                    host.writeMemory(info >>> 0, bytes);
                }
                return 0;
            },
        },

        /**
         * LRESULT ICClose(HIC hic)
         *
         * No compressor is ever opened here, so no handle is one of ours:
         * ICERR_BADHANDLE, what the manager answers for a handle it never
         * gave out.
         */
        ICClose: { argBytes: 4, handler: ()=>ICERR_BADHANDLE },

        /**
         * HWND MCIWndCreateA(HWND hwndParent, HINSTANCE hInstance, DWORD dwStyle,
         *                    LPCSTR szFile)
         *
         * Zero when the window cannot be made; there is no MCI video device
         * to open the clip on.
         */
        MCIWndCreateA: { argBytes: 16, handler: ()=>0 },
        MCIWndCreateW: { argBytes: 16, handler: ()=>0 },

        /**
         * BOOL MCIWndRegisterClass(void)
         *
         * The class is not provided, and saying so keeps a caller from making
         * a window of a class that does not exist.
         */
        MCIWndRegisterClass: { argBytes: 0, handler: ()=>0 },
    };
}
