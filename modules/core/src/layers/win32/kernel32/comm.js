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
 */

import { createRefusals } from '../common/refusal.js';

const ERROR_INVALID_FUNCTION = 1;
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
 * @typedef {Object} CommHost
 * @property {{ typeOf?: (handle: number) => string | undefined | null }} handles
 * @property {(code: number) => void} setLastError
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {CommHost} host
 */
export function createCommFunctions(host){
    const refuse = createRefusals({ divergence: host.divergence });

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

    return Object.fromEntries(Object.entries(SERIAL_CALLS).map(([name, argBytes])=>{
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
    }));
}
