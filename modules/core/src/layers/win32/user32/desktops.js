/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Window stations and desktops: the objects a process's windows live inside.
 *
 * There is one window station here, WinSta0, and it starts with the one
 * desktop every process is given, Default, which takes the input. A program
 * may make more and switch the input between them, and each handle it opens
 * names one of them -- that is what these calls keep. Which desktop a window
 * is on is not kept: every window is drawn and reached as though it were on
 * the input desktop, which is the one a person sees.
 */

import { threadIdOf } from './messages.js';
import { readText, textBytes } from './unicode.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_BUSY = 170;
const ERROR_FILE_NOT_FOUND = 2;

/** GetUserObjectInformation's indices. */
const UOI_FLAGS = 1;
const UOI_NAME = 2;
const UOI_TYPE = 3;
const UOI_USER_SID = 4;
const UOI_IO = 6;

/** USEROBJECTFLAGS: fInherit, fReserved, dwFlags. */
const USEROBJECTFLAGS_SIZE = 12;

/** A desktop's or a station's name is kept to this. */
const MAX_NAME = 256;

/**
 * @typedef {{ kind: 'desktop' | 'station', name: string, flags: number }} UserObject
 * @typedef {{ object: UserObject, inherit: boolean }} UserHandle
 */

/**
 * @param {Object} options
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void,
 *     readCString: (address: number, maxLength: number) => string,
 *     handles: { open: (type: string, object: any) => number,
 *         close: (handle: number) => any,
 *         typeOf?: (handle: number) => string | null,
 *         resolve?: (handle: number, type: string) => any },
 *     callerThread?: () => unknown,
 *     setLastError?: (code: number) => void,
 *     call?: (entry: number, args: number[], thread?: unknown) => number | Promise<number>,
 *     allocate?: (bytes: number) => number,
 *     release?: (address: number) => void }} options.host
 * @param {() => number[]} options.topLevel  The top-level windows, topmost first.
 */
export function createDesktopFunctions({ host, topLevel }){
    /** @type {UserObject} */
    const station = { kind: 'station', name: 'WinSta0', flags: 0 };
    /** @type {UserObject} */
    const standard = { kind: 'desktop', name: 'Default', flags: 0 };
    /** The desktops of the station, by name without regard to case. @type {UserObject[]} */
    const desktops = [standard];
    /** The desktop that takes the input. */
    let input = standard;

    /**
     * What a handle of this layer names, or null for one it did not open.
     *
     * @type {Map<number, UserHandle>}
     */
    const opened = new Map();
    /**
     * The desktop each thread is on, and the handle GetThreadDesktop gives
     * out for it -- the same one every time, and one the thread cannot close
     * while it is on that desktop.
     *
     * @type {Map<number | null, number>}
     */
    const threadDesktops = new Map();
    /** The handle GetProcessWindowStation gives out, made when first asked for. */
    let stationHandle = 0;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /** @param {UserObject} object @param {boolean} inherit */
    const open = (object, inherit)=>{
        const handle = host.handles.open(object.kind === 'desktop' ? 'desktop' : 'winstation',
            object);
        opened.set(handle, { object, inherit });
        return handle;
    };

    /** @param {number} handle @param {'desktop' | 'station'} kind */
    const named = (handle, kind)=>{
        const entry = opened.get(handle >>> 0);
        return entry && entry.object.kind === kind ? entry : null;
    };

    /** @param {string} name */
    const desktopNamed = name=>desktops.find(each=>each.name.toLowerCase() === name.toLowerCase())
        ?? null;

    /** The handle naming the desktop the calling thread is on. */
    const threadHandle = ()=>{
        const thread = threadIdOf(host.callerThread?.());
        let handle = threadDesktops.get(thread);
        if (handle === undefined || !opened.has(handle))
        {
            handle = open(standard, false);
            threadDesktops.set(thread, handle);
        }
        return handle;
    };

    /**
     * CreateDesktop in either encoding: a desktop of that name on the
     * station, or the one already there by it.
     *
     * @param {number[]} args  lpszDesktop, lpszDevice, pDevmode, dwFlags, dwDesiredAccess, lpsa.
     * @param {boolean} unicode
     */
    const createDesktop = ([name, device, mode, flags], unicode)=>{
        if ((name >>> 0) === 0 || (device >>> 0) !== 0 || (mode >>> 0) !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const text = readText(host, name >>> 0, unicode, MAX_NAME);
        if (text.length === 0 || text.includes('\\'))
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        let desktop = desktopNamed(text);
        if (!desktop)
        {
            desktop = { kind: 'desktop', name: text, flags: flags >>> 0 };
            desktops.push(desktop);
        }
        return open(desktop, false);
    };

    /**
     * OpenDesktop in either encoding.
     *
     * @param {number[]} args  lpszDesktop, dwFlags, fInherit, dwDesiredAccess.
     * @param {boolean} unicode
     */
    const openDesktop = ([name, , inherit], unicode)=>{
        if ((name >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const desktop = desktopNamed(readText(host, name >>> 0, unicode, MAX_NAME));
        return desktop ? open(desktop, inherit !== 0) : fail(ERROR_FILE_NOT_FOUND);
    };

    /**
     * Closes a handle of either kind, which one the thread is on may not be.
     *
     * @param {number} handle @param {'desktop' | 'station'} kind
     */
    const close = (handle, kind)=>{
        if (!named(handle, kind))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if ([...threadDesktops.values()].includes(handle >>> 0) || (handle >>> 0) === stationHandle)
        {
            return fail(ERROR_BUSY);
        }
        opened.delete(handle >>> 0);
        host.handles.close(handle >>> 0);
        return 1;
    };

    /**
     * GetUserObjectInformation in either encoding.
     *
     * @param {number[]} args  hObj, nIndex, pvInfo, nLength, lpnLengthNeeded.
     * @param {boolean} unicode
     */
    const userObjectInformation = ([handle, index, into, length, needed], unicode)=>{
        const entry = opened.get(handle >>> 0);
        if (!entry)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        /** @type {Uint8Array} */
        let bytes;
        switch (index | 0){
            case UOI_FLAGS:
                bytes = new Uint8Array(USEROBJECTFLAGS_SIZE);
                new DataView(bytes.buffer).setUint32(0, entry.inherit ? 1 : 0, true);
                new DataView(bytes.buffer).setUint32(8, entry.object.flags, true);
                break;
            case UOI_NAME:
                bytes = textBytes(entry.object.name, unicode);
                break;
            case UOI_TYPE:
                bytes = textBytes(entry.object.kind === 'desktop' ? 'Desktop' : 'WindowStation',
                    unicode);
                break;
            case UOI_USER_SID:
                bytes = new Uint8Array(0);
                break;
            case UOI_IO:
                bytes = new Uint8Array(4);
                bytes[0] = entry.object === input ? 1 : 0;
                break;
            default:
                return fail(ERROR_INVALID_PARAMETER);
        }
        if ((needed >>> 0) !== 0)
        {
            host.writeMemory(needed >>> 0, new Uint8Array(new Uint32Array([bytes.length]).buffer));
        }
        if ((length >>> 0) < bytes.length || ((into >>> 0) === 0 && bytes.length > 0))
        {
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        if (bytes.length > 0)
        {
            host.writeMemory(into >>> 0, bytes);
        }
        return 1;
    };

    /**
     * EnumDesktops in either encoding: the station's desktops by name, each
     * handed to the callback until one answers FALSE.
     *
     * @param {number[]} args  hwinsta, lpEnumFunc, lParam.
     * @param {boolean} unicode
     */
    const enumDesktops = ([handle, callback, lParam], unicode)=>{
        if ((handle >>> 0) !== 0 && !named(handle, 'station'))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const call = host.call;
        if (!call || (callback >>> 0) === 0 || !host.allocate)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const thread = host.callerThread?.();
        const names = desktops.map(each=>textBytes(each.name, unicode));
        return (async()=>{
            for (const bytes of names)
            {
                const at = host.allocate?.(bytes.length) ?? 0;
                if (at === 0)
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                host.writeMemory(at, bytes);
                const going = await call(callback >>> 0, [at, lParam >>> 0], thread);
                host.release?.(at);
                if ((going | 0) === 0)
                {
                    return 0;
                }
            }
            return 1;
        })();
    };

    return {
        /** HDESK OpenInputDesktop(DWORD dwFlags, BOOL fInherit, ACCESS_MASK dwDesiredAccess) */
        OpenInputDesktop: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, inherit])=>open(input, inherit !== 0),
        },

        /**
         * HDESK CreateDesktopA(LPCSTR lpszDesktop, LPCSTR lpszDevice, DEVMODEA *pDevmode,
         *     DWORD dwFlags, ACCESS_MASK dwDesiredAccess, LPSECURITY_ATTRIBUTES lpsa)
         */
        CreateDesktopA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>createDesktop(args, false),
        },

        /** HDESK CreateDesktopW(...), with wide names. */
        CreateDesktopW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>createDesktop(args, true),
        },

        /** HDESK OpenDesktopA(LPCSTR lpszDesktop, DWORD dwFlags, BOOL fInherit, ACCESS_MASK) */
        OpenDesktopA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>openDesktop(args, false),
        },

        /** HDESK OpenDesktopW(LPCWSTR lpszDesktop, DWORD dwFlags, BOOL fInherit, ACCESS_MASK) */
        OpenDesktopW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>openDesktop(args, true),
        },

        /**
         * BOOL SwitchDesktop(HDESK hDesktop)
         *
         * Makes a desktop the one that takes the input, and the one
         * OpenInputDesktop opens from then on.
         */
        SwitchDesktop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const entry = named(handle, 'desktop');
                if (!entry)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                input = entry.object;
                return 1;
            },
        },

        /** BOOL CloseDesktop(HDESK hDesktop) */
        CloseDesktop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>close(handle, 'desktop'),
        },

        /**
         * HDESK GetThreadDesktop(DWORD dwThreadId)
         *
         * The handle of the desktop the thread is on, the same every time:
         * it is the thread's, and not the caller's to close.
         */
        GetThreadDesktop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([thread])=>{
                if ((thread >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const own = threadIdOf(host.callerThread?.());
                if (own === null || own === (thread >>> 0))
                {
                    return threadHandle();
                }
                const handle = threadDesktops.get(thread >>> 0);
                return handle !== undefined && opened.has(handle) ? handle : threadHandle();
            },
        },

        /**
         * BOOL SetThreadDesktop(HDESK hDesktop)
         *
         * Puts the calling thread on a desktop. The handle becomes the one
         * GetThreadDesktop answers, and closing it fails while it is.
         */
        SetThreadDesktop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!named(handle, 'desktop'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                threadDesktops.set(threadIdOf(host.callerThread?.()), handle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL EnumDesktopWindows(HDESK hDesktop, WNDENUMPROC lpfn, LPARAM lParam)
         *
         * The top-level windows, which here are every one on the desktop that
         * takes the input and none on any other.
         */
        EnumDesktopWindows: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, callback, lParam])=>{
                const entry = (handle >>> 0) === 0 ? { object: input } : named(handle, 'desktop');
                const call = host.call;
                if (!entry)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!call || (callback >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const thread = host.callerThread?.();
                const listed = entry.object === input ? topLevel() : [];
                return (async()=>{
                    for (const hwnd of listed)
                    {
                        if ((await call(callback >>> 0, [hwnd, lParam >>> 0], thread) | 0) === 0)
                        {
                            return 0;
                        }
                    }
                    return 1;
                })();
            },
        },

        /** BOOL EnumDesktopsA(HWINSTA hwinsta, DESKTOPENUMPROCA lpEnumFunc, LPARAM lParam) */
        EnumDesktopsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>enumDesktops(args, false),
        },

        /** BOOL EnumDesktopsW(HWINSTA hwinsta, DESKTOPENUMPROCW lpEnumFunc, LPARAM lParam) */
        EnumDesktopsW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>enumDesktops(args, true),
        },

        /** HWINSTA GetProcessWindowStation(void) */
        GetProcessWindowStation: {
            argBytes: 0,
            handler: ()=>{
                if (stationHandle === 0 || !opened.has(stationHandle))
                {
                    stationHandle = open(station, false);
                }
                return stationHandle;
            },
        },

        /** HWINSTA OpenWindowStationA(LPCSTR lpszWinSta, BOOL fInherit, ACCESS_MASK) */
        OpenWindowStationA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, inherit])=>((name >>> 0) !== 0
                && host.readCString(name >>> 0, MAX_NAME).toLowerCase() === 'winsta0'
                ? open(station, inherit !== 0) : fail(ERROR_FILE_NOT_FOUND)),
        },

        /** HWINSTA OpenWindowStationW(LPCWSTR lpszWinSta, BOOL fInherit, ACCESS_MASK) */
        OpenWindowStationW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, inherit])=>((name >>> 0) !== 0
                && readText(host, name >>> 0, true, MAX_NAME).toLowerCase() === 'winsta0'
                ? open(station, inherit !== 0) : fail(ERROR_FILE_NOT_FOUND)),
        },

        /** BOOL CloseWindowStation(HWINSTA hWinSta) */
        CloseWindowStation: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>close(handle, 'station'),
        },

        /** BOOL SetProcessWindowStation(HWINSTA hWinSta) */
        SetProcessWindowStation: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(named(handle, 'station') ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /**
         * BOOL GetUserObjectInformationA(HANDLE hObj, int nIndex, PVOID pvInfo,
         *     DWORD nLength, LPDWORD lpnLengthNeeded)
         *
         * A desktop's or a station's flags, name, kind, or whether it takes
         * the input; the size wanted is written whether or not it fits, and
         * one that does not is ERROR_INSUFFICIENT_BUFFER.
         */
        GetUserObjectInformationA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>userObjectInformation(args, false),
        },

        /** BOOL GetUserObjectInformationW(...), with wide names. */
        GetUserObjectInformationW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>userObjectInformation(args, true),
        },
    };
}
