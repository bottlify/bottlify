/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The serial port calls, on a machine with no serial port.
 *
 * Each of them is a request to the driver of the device the handle names --
 * a control code the serial driver answers -- and no handle here names one:
 * there is no COM device to open, so a handle a program holds is a file, a
 * pipe, an event or nothing. Windows answers such a request by what the
 * handle is: a file system does not handle the serial control codes and says
 * ERROR_INVALID_FUNCTION, as DeviceIoControl does here for any code; anything
 * that is not a file object -- a stale handle, an event, a console -- is
 * ERROR_INVALID_HANDLE. Every call fails, FALSE, through the shared refusals,
 * so a run says once which serial calls a program made.
 *
 * BuildCommDCB needs no port: it reads a control string into a DCB
 * (`comm-dcb.js`).
 */

import { createRefusals } from '../common/refusal.js';
import { applyCommSettings, DCB_SIZE, parseCommString, TIMEOUTS_SIZE } from './comm-dcb.js';

const ERROR_INVALID_FUNCTION = 1;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
/** How far a control string is read: whole. */
const WHOLE_STRING = 32767;
const ERROR_INVALID_HANDLE = 6;

/** The handle kinds that are file objects, which a driver below them refuses. */
const FILE_OBJECTS = new Set(['file', 'directory', 'pipe-read', 'pipe-write']);

/**
 * Every serial call, with its arguments' bytes: the ones a program sets a
 * port up with, the ones it reads its state with, and the line controls.
 */
export const SERIAL_CALLS = Object.freeze({
    GetCommState: 8,
    SetCommState: 8,
    SetupComm: 12,
    PurgeComm: 8,
    WaitCommEvent: 12,
    ClearCommError: 12,
    EscapeCommFunction: 8,
    GetCommConfig: 12,
    SetCommConfig: 12,
    GetCommMask: 8,
    SetCommMask: 8,
    GetCommTimeouts: 8,
    SetCommTimeouts: 8,
    GetCommModemStatus: 8,
    GetCommProperties: 8,
    SetCommBreak: 4,
    ClearCommBreak: 4,
    TransmitCommChar: 8,
});

/**
 * The calls that name a port rather than hold a handle to one, with their
 * arguments' bytes: no port by any name is here, so each fails as for a
 * port that does not exist, ERROR_FILE_NOT_FOUND as CreateFile gives for one.
 */
export const PORT_CALLS = Object.freeze({
    GetDefaultCommConfigA: 12,
    GetDefaultCommConfigW: 12,
    SetDefaultCommConfigA: 12,
    SetDefaultCommConfigW: 12,
    CommConfigDialogA: 12,
    CommConfigDialogW: 12,
});

/**
 * @typedef {Object} CommHost
 * @property {{ typeOf?: (handle: number) => string | undefined | null }} handles
 * @property {(code: number) => void} setLastError
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString  limit in bytes
 */

/**
 * @param {CommHost} host
 */
export function createCommFunctions(host){
    const refuse = createRefusals({ setLastError: host.setLastError, divergence: host.divergence });

    /** @param {number} handle */
    const kindOf = handle=>{
        try
        {
            return host.handles.typeOf?.(handle >>> 0) ?? null;
        }
        catch (e){
            void e;
            return null;
        }
    };

    const byName = Object.entries(PORT_CALLS).map(([name, argBytes])=>[name,
        refuse(name, { argBytes, lastError: ERROR_FILE_NOT_FOUND,
            why: 'there is no serial port on this machine' })]);

    /**
     * BuildCommDCB and BuildCommDCBAndTimeouts in either width: a string
     * Windows refuses changes nothing and is ERROR_INVALID_PARAMETER; one it
     * takes leaves the last error alone.
     *
     * @param {(address: number) => string} readText @param {boolean} withTimeouts
     */
    const buildDcb = (readText, withTimeouts)=>({
        argBytes: withTimeouts ? 12 : 8,
        /** @param {number[]} args */
        handler: ([text, dcb, timeouts])=>{
            const settings = (text >>> 0) === 0 ? null : parseCommString(readText(text >>> 0));
            if (settings === null)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const block = host.readMemory(dcb >>> 0, DCB_SIZE).slice();
            const times = withTimeouts && (timeouts >>> 0) !== 0
                ? host.readMemory(timeouts >>> 0, TIMEOUTS_SIZE).slice() : null;
            applyCommSettings(settings, block, times);
            host.writeMemory(dcb >>> 0, block);
            if (times)
            {
                host.writeMemory(timeouts >>> 0, times);
            }
            return 1;
        },
    });
    const ansi = (/** @type {number} */ address)=>host.readCString(address, WHOLE_STRING);
    const wide = (/** @type {number} */ address)=>host.readWideString(address, WHOLE_STRING * 2);
    const builders = [
        /** BOOL BuildCommDCBA(LPCSTR lpDef, LPDCB lpDCB) */
        ['BuildCommDCBA', buildDcb(ansi, false)],
        /** BOOL BuildCommDCBW(LPCWSTR lpDef, LPDCB lpDCB) */
        ['BuildCommDCBW', buildDcb(wide, false)],
        /** BOOL BuildCommDCBAndTimeoutsA(LPCSTR, LPDCB, LPCOMMTIMEOUTS) */
        ['BuildCommDCBAndTimeoutsA', buildDcb(ansi, true)],
        /** BOOL BuildCommDCBAndTimeoutsW(LPCWSTR, LPDCB, LPCOMMTIMEOUTS) */
        ['BuildCommDCBAndTimeoutsW', buildDcb(wide, true)],
    ];

    const handled = Object.entries(SERIAL_CALLS).map(([name, argBytes])=>{
        const refusal = refuse(name, { argBytes, why: 'there is no serial port on this machine' });
        return [name, {
            argBytes,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const kind = kindOf(handle);
                host.setLastError(kind !== null && FILE_OBJECTS.has(kind)
                    ? ERROR_INVALID_FUNCTION : ERROR_INVALID_HANDLE);
                return refusal.handler();
            },
        }];
    });

    return Object.fromEntries([...builders, ...byName, ...handled]);
}
