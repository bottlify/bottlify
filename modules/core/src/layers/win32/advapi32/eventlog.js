/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The event log a service or an installer's helper reports to.
 *
 * A source is registered, events are written against its handle, and the
 * handle is let go. Nothing reads the log on this machine -- there is no
 * event viewer and no service that does -- so an event is accepted and
 * forgotten: refusing it would stop a program that only meant to leave a
 * note, and a program that reads its own events back is not one this
 * answers for. The source's name is kept for the handle's life, so a
 * handle that was never handed out is refused as such.
 */

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;

/** @typedef {(address: number, maxLength: number) => string} Reader */

/**
 * @typedef {Object} EventLogHost
 * @property {Reader} readCString
 * @property {Reader} readWideString
 * @property {(code: number) => void} setLastError
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 */

/** The longest source name read out of the guest. */
const MAX_SOURCE = 256;

/**
 * @param {EventLogHost} host
 */
export function createEventLogFunctions(host){
    /** @param {number} handle */
    const isSource = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, 'eventlog') != null;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /** @param {Reader} read */
    const register = read=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([, source])=>{
            if ((source >>> 0) === 0)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            return host.handles.open('eventlog', { source: read(source >>> 0, MAX_SOURCE) });
        },
    });

    const report = {
        argBytes: 36,
        /** @param {number[]} args */
        handler: ([log])=>{
            if (!isSource(log))
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            return 1;
        },
    };

    return {
        /** HANDLE RegisterEventSourceA(LPCSTR lpUNCServerName, LPCSTR lpSourceName) */
        RegisterEventSourceA: register(host.readCString),
        /** HANDLE RegisterEventSourceW(LPCWSTR lpUNCServerName, LPCWSTR lpSourceName) */
        RegisterEventSourceW: register((address, length)=>host.readWideString(address, length * 2)),

        /** BOOL DeregisterEventSource(HANDLE hEventLog) */
        DeregisterEventSource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([log])=>{
                if (!isSource(log))
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                host.handles.close(log >>> 0);
                return 1;
            },
        },

        /**
         * BOOL ReportEventA(HANDLE hEventLog, WORD wType, WORD wCategory, DWORD dwEventID,
         *   PSID lpUserSid, WORD wNumStrings, DWORD dwDataSize, LPCSTR *lpStrings,
         *   LPVOID lpRawData)
         */
        ReportEventA: report,
        /** ReportEventW: the same, its strings in UTF-16. */
        ReportEventW: report,
    };
}
