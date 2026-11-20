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
 *
 * The message filter User Interface Privilege Isolation keeps lives here too:
 * every process here runs at one integrity level, so no message is ever held
 * back by it, and a program's changes to it are kept only to answer what
 * the next one finds.
 */

import { threadIdOf } from './messages.js';
import { forwarded, wholeAddress } from '../common/pointers.js';
import { readText, textBytes } from './unicode.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_NOACCESS = 998;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_BUSY = 170;
const ERROR_FILE_NOT_FOUND = 2;

/** USEROBJECTFLAGS.dwFlags of a window station that has visible surfaces. */
const WSF_VISIBLE = 1;

/** GetUserObjectInformation's indices. */
const UOI_FLAGS = 1;
const UOI_NAME = 2;
/** What SetShellWindow leaves for a handle that is no window. */
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const UOI_TYPE = 3;
const UOI_USER_SID = 4;
const UOI_IO = 6;

/** ChangeWindowMessageFilter's flags, and ChangeWindowMessageFilterEx's actions. */
const MSGFLT_ADD = 1;
const MSGFLT_REMOVE = 2;
const MSGFLT_RESET = 0;
const MSGFLT_ALLOW = 1;
const MSGFLT_DISALLOW = 2;
/** CHANGEFILTERSTRUCT: cbSize, ExtStatus. */
const CHANGEFILTERSTRUCT_SIZE = 8;
const MSGFLTINFO_NONE = 0;
const MSGFLTINFO_ALREADYALLOWED_FORWND = 1;
const MSGFLTINFO_ALREADYDISALLOWED_FORWND = 2;

/** USEROBJECTFLAGS: fInherit, fReserved, dwFlags. */
const USEROBJECTFLAGS_SIZE = 12;

/** A desktop's or a station's name is kept to this. */
const MAX_NAME = 256;

/**
 * @typedef {{ kind: 'desktop' | 'station', name: string, flags: number,
 *     shell?: number }} UserObject  `shell`: the shell window SetShellWindow named.
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
 *     release?: (address: number) => void,
 *     divergence?: (api: string, detail: string) => void }} options.host
 * @param {() => number[]} options.topLevel  The top-level windows, topmost first.
 * @param {(hwnd: number) => { exStyle: number } | null} [options.windowOf]
 *        A live window by its handle.
 * @param {(hwnd: number) => void} [options.toBottom]
 *        Puts a top-level window at the bottom of the stacking.
 */
export function createDesktopFunctions({ host, topLevel, windowOf, toBottom }){
    /**
     * The interactive station, visible (WSF_VISIBLE), as the logged-on user's
     * WinSta0 is: .NET's UserInteractive reads this flag, and without it
     * WinForms refused every message box as shown from a service.
     *
     * @type {UserObject}
     */
    const station = { kind: 'station', name: 'WinSta0', flags: WSF_VISIBLE };
    /** @type {UserObject} */
    const standard = { kind: 'desktop', name: 'Default', flags: 0 };
    /** The desktops of the station, by name without regard to case. @type {UserObject[]} */
    const desktops = [standard];
    /** The desktop that takes the input. */
    let input = standard;
    /** Whether SetUserObjectSecurity has said it keeps nothing. */
    let securitySaid = false;

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
    /** Stations made beside WinSta0 (CreateWindowStation), by name without regard to case. */
    /** @type {UserObject[]} */
    const stations = [station];
    /** How many unnamed stations have been made, for their generated names. */
    let unnamed = 0;
    /** The station SetProcessWindowStation chose, when not WinSta0. @type {UserObject} */
    let processStation = station;

    /** @param {string} name */
    const stationNamed = name=>stations.find(each=>each.name.toLowerCase() === name.toLowerCase())
        ?? null;

    /**
     * CreateWindowStation in either width: a station of that name, made or
     * opened, or for no name one named as Windows names a service's
     * (Service-0x0-<n>$). Its desktops are not kept apart from WinSta0's:
     * every window is drawn on the input desktop all the same.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const createStation = ([name, , , attributes], wide)=>{
        const text = (name >>> 0) === 0 ? null
            : wide ? readText(host, name >>> 0, true, MAX_NAME)
                : host.readCString(wholeAddress(name), MAX_NAME);
        let made = text === null ? null : stationNamed(text);
        if (!made)
        {
            made = { kind: 'station',
                name: text ?? `Service-0x0-${(0x3e7 + ++unnamed).toString(16)}$`, flags: 0 };
            stations.push(made);
        }
        const inherit = (attributes >>> 0) !== 0
            && new DataView(host.readMemory(wholeAddress(attributes) + 8, 4).slice().buffer)
                .getUint32(0, true) !== 0;
        return open(made, inherit);
    };

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
            host.writeMemory(wholeAddress(needed),
                new Uint8Array(new Uint32Array([bytes.length]).buffer));
        }
        if ((length >>> 0) < bytes.length || ((into >>> 0) === 0 && bytes.length > 0))
        {
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        if (bytes.length > 0)
        {
            host.writeMemory(wholeAddress(into), bytes);
        }
        return 1;
    };

    /**
     * Hands each name to an enumeration's callback until one answers FALSE.
     * The call answers what the callback last answered, as EnumDesktops and
     * EnumWindowStations do: an lParam a callback hands back comes back.
     *
     * @param {UserObject[]} objects @param {number} callback @param {number} lParam
     * @param {boolean} unicode
     */
    const enumNames = (objects, callback, lParam, unicode)=>{
        const call = host.call;
        if (!call || (callback >>> 0) === 0 || !host.allocate)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const thread = host.callerThread?.();
        const names = objects.map(each=>textBytes(each.name, unicode));
        return (async()=>{
            let answer = 1;
            for (const bytes of names)
            {
                const at = host.allocate?.(bytes.length) ?? 0;
                if (at === 0)
                {
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                host.writeMemory(at, bytes);
                answer = await call(callback >>> 0, [at, lParam], thread) >>> 0;
                host.release?.(at);
                if (answer === 0)
                {
                    break;
                }
            }
            return answer;
        })();
    };

    /**
     * EnumDesktops in either encoding: the station's desktops by name.
     *
     * @param {number[]} args  hwinsta, lpEnumFunc, lParam.
     * @param {boolean} unicode
     */
    const enumDesktops = (args, unicode)=>{
        const [handle, callback] = args;
        const lParam = /** @type {number} */ (forwarded(args, 2, true));
        if ((handle >>> 0) !== 0 && !named(handle, 'station'))
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        return enumNames(desktops, callback, lParam, unicode);
    };

    /**
     * SetUserObjectInformation in either encoding: only UOI_FLAGS can be set
     * (USEROBJECTFLAGS: fInherit, fReserved, dwFlags), and it must be whole.
     *
     * @param {number[]} args  hObj, nIndex, pvInfo, nLength.
     */
    const setUserObjectInformation = ([handle, index, from, length])=>{
        const entry = opened.get(handle >>> 0);
        if (!entry)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if ((index | 0) !== UOI_FLAGS || (length >>> 0) < USEROBJECTFLAGS_SIZE
            || (from >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const view = new DataView(host.readMemory(wholeAddress(from),
            USEROBJECTFLAGS_SIZE).slice().buffer);
        entry.inherit = view.getUint32(0, true) !== 0;
        entry.object.flags = view.getUint32(8, true);
        return 1;
    };

    /**
     * The security descriptor GetUserObjectSecurity gives for a desktop or a
     * station: self-relative, with a DACL that allows everyone all access
     * when the DACL is asked for; the engine keeps no other security on them.
     *
     * @param {number} asked  SECURITY_INFORMATION's bits.
     */
    const userObjectSecurity = asked=>{
        const DACL_SECURITY_INFORMATION = 0x4;
        const SE_DACL_PRESENT = 0x0004;
        const SE_SELF_RELATIVE = 0x8000;
        const HEADER = 20;
        const withDacl = (asked & DACL_SECURITY_INFORMATION) !== 0;
        // ACL header (8), one ACCESS_ALLOWED_ACE (8) with S-1-1-0, Everyone (12).
        const ACL_SIZE = 8 + 8 + 12;
        const bytes = new Uint8Array(HEADER + (withDacl ? ACL_SIZE : 0));
        const view = new DataView(bytes.buffer);
        view.setUint8(0, 1);
        view.setUint16(2, SE_SELF_RELATIVE | (withDacl ? SE_DACL_PRESENT : 0), true);
        if (withDacl)
        {
            view.setUint32(16, HEADER, true);
            view.setUint8(HEADER, 2);
            view.setUint16(HEADER + 2, ACL_SIZE, true);
            view.setUint16(HEADER + 4, 1, true);
            const ace = HEADER + 8;
            view.setUint16(ace + 2, 20, true);
            view.setUint32(ace + 4, 0x10000000, true);
            view.setUint8(ace + 8, 1);
            view.setUint8(ace + 9, 1);
            view.setUint8(ace + 15, 1);
        }
        return bytes;
    };

    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at, 4).slice().buffer).getUint32(0, true);
    /** The messages each window was told to let in (ChangeWindowMessageFilterEx). */
    const allowedFor = new Map();

    return {
        /**
         * BOOL ChangeWindowMessageFilter(UINT message, DWORD dwFlag)
         *
         * MSGFLT_ADD or MSGFLT_REMOVE for the whole process: accepted, as
         * there is no lower integrity level to filter.
         */
        ChangeWindowMessageFilter: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, flag])=>{
                if ((flag >>> 0) !== MSGFLT_ADD && (flag >>> 0) !== MSGFLT_REMOVE)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return 1;
            },
        },

        /**
         * BOOL ChangeWindowMessageFilterEx(HWND hwnd, UINT message, DWORD action,
         *     PCHANGEFILTERSTRUCT pChangeFilterStruct)
         *
         * For one window of this process: MSGFLT_RESET, MSGFLT_ALLOW,
         * MSGFLT_DISALLOW. The structure, when given, must say its size and
         * is told whether the message was let in or kept out already.
         */
        ChangeWindowMessageFilterEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, action, info])=>{
                if (!windowOf?.(hwnd >>> 0))
                {
                    host.setLastError?.(ERROR_INVALID_WINDOW_HANDLE);
                    return 0;
                }
                const at = wholeAddress(info);
                if ((action >>> 0) > MSGFLT_DISALLOW
                    || (at !== 0 && readU32(at) !== CHANGEFILTERSTRUCT_SIZE))
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                /** @type {Set<number>} */
                const allowed = allowedFor.get(hwnd >>> 0) ?? new Set();
                allowedFor.set(hwnd >>> 0, allowed);
                const was = allowed.has(message >>> 0);
                let status = MSGFLTINFO_NONE;
                if ((action >>> 0) === MSGFLT_RESET)
                {
                    allowed.clear();
                }
                else if ((action >>> 0) === MSGFLT_ALLOW)
                {
                    status = was ? MSGFLTINFO_ALREADYALLOWED_FORWND : MSGFLTINFO_NONE;
                    allowed.add(message >>> 0);
                }
                else
                {
                    status = was ? MSGFLTINFO_NONE : MSGFLTINFO_ALREADYDISALLOWED_FORWND;
                    allowed.delete(message >>> 0);
                }
                if (at !== 0)
                {
                    host.writeMemory(at + 4, new Uint8Array(new Uint32Array([status]).buffer));
                }
                return 1;
            },
        },

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
         * HWND GetShellWindow(void)
         *
         * The calling thread's desktop's shell window, which only
         * SetShellWindow names: there is no shell here to have made one.
         */
        GetShellWindow: {
            argBytes: 0,
            handler: ()=>{
                const shell = opened.get(threadHandle())?.object.shell ?? 0;
                return windowOf?.(shell) ? shell : 0;
            },
        },

        /**
         * BOOL SetShellWindow(HWND hwnd)
         *
         * Names the desktop's shell window, once: refused while one is, and
         * for a topmost window. The shell window goes to the bottom of the
         * stacking.
         */
        SetShellWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const WS_EX_TOPMOST = 0x00000008;
                const desktop = opened.get(threadHandle())?.object;
                const record = windowOf?.(hwnd >>> 0) ?? null;
                if (!desktop || windowOf?.(desktop.shell ?? 0))
                {
                    return 0;
                }
                if (!record)
                {
                    return fail(ERROR_INVALID_WINDOW_HANDLE);
                }
                if ((record.exStyle & WS_EX_TOPMOST) !== 0)
                {
                    return 0;
                }
                desktop.shell = hwnd >>> 0;
                toBottom?.(hwnd >>> 0);
                return 1;
            },
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
            handler: args=>{
                const [handle, callback] = args;
                const lParam = /** @type {number} */ (forwarded(args, 2, true));
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
                        if ((await call(callback >>> 0, [hwnd, lParam], thread) | 0) === 0)
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

        /**
         * BOOL EnumWindowStationsA(WINSTAENUMPROCA lpEnumFunc, LPARAM lParam)
         *
         * The stations by name: WinSta0 and those CreateWindowStation made.
         */
        EnumWindowStationsA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>enumNames(stations, args[0],
                /** @type {number} */ (forwarded(args, 1, true)), false),
        },
        /** BOOL EnumWindowStationsW(WINSTAENUMPROCW lpEnumFunc, LPARAM lParam) */
        EnumWindowStationsW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: args=>enumNames(stations, args[0],
                /** @type {number} */ (forwarded(args, 1, true)), true),
        },

        /**
         * BOOL SetUserObjectInformationA(HANDLE hObj, int nIndex, PVOID pvInfo,
         *     DWORD nLength), and the W form: the same, no text being set.
         */
        SetUserObjectInformationA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setUserObjectInformation(args),
        },
        SetUserObjectInformationW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>setUserObjectInformation(args),
        },

        /**
         * BOOL GetUserObjectSecurity(HANDLE hObj, PSECURITY_INFORMATION pSIRequested,
         *     PSECURITY_DESCRIPTOR pSID, DWORD nLength, LPDWORD lpnLengthNeeded)
         *
         * The size is written whether or not it fits; a buffer too small is
         * ERROR_INSUFFICIENT_BUFFER.
         */
        GetUserObjectSecurity: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, requested, into, length, needed])=>{
                if (!opened.has(handle >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((requested >>> 0) === 0 || (needed >>> 0) === 0)
                {
                    return fail(ERROR_NOACCESS);
                }
                const bytes = userObjectSecurity(readU32(wholeAddress(requested)));
                host.writeMemory(wholeAddress(needed),
                    new Uint8Array(new Uint32Array([bytes.length]).buffer));
                if ((length >>> 0) < bytes.length || (into >>> 0) === 0)
                {
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                host.writeMemory(wholeAddress(into), bytes);
                return 1;
            },
        },

        /**
         * BOOL SetUserObjectSecurity(HANDLE hObj, PSECURITY_INFORMATION pSIRequested,
         *     PSECURITY_DESCRIPTOR pSID)
         *
         * Accepted and not kept: the engine's desktops and stations have no
         * security to change, and GetUserObjectSecurity answers as before.
         */
        SetUserObjectSecurity: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!opened.has(handle >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!securitySaid)
                {
                    securitySaid = true;
                    host.divergence?.('SetUserObjectSecurity',
                        'a desktop\'s or station\'s security is accepted and not kept');
                }
                return 1;
            },
        },

        /** HWINSTA GetProcessWindowStation(void) */
        GetProcessWindowStation: {
            argBytes: 0,
            handler: ()=>{
                if (stationHandle === 0 || !opened.has(stationHandle)
                    || opened.get(stationHandle)?.object !== processStation)
                {
                    stationHandle = open(processStation, false);
                }
                return stationHandle;
            },
        },

        /** HWINSTA OpenWindowStationA(LPCSTR lpszWinSta, BOOL fInherit, ACCESS_MASK) */
        OpenWindowStationA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, inherit])=>{
                const found = (name >>> 0) === 0 ? null
                    : stationNamed(host.readCString(wholeAddress(name), MAX_NAME));
                return found ? open(found, inherit !== 0) : fail(ERROR_FILE_NOT_FOUND);
            },
        },

        /** HWINSTA OpenWindowStationW(LPCWSTR lpszWinSta, BOOL fInherit, ACCESS_MASK) */
        OpenWindowStationW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, inherit])=>{
                const found = (name >>> 0) === 0 ? null
                    : stationNamed(readText(host, name >>> 0, true, MAX_NAME));
                return found ? open(found, inherit !== 0) : fail(ERROR_FILE_NOT_FOUND);
            },
        },

        /**
         * HWINSTA CreateWindowStationA(LPCSTR lpwinsta, DWORD dwFlags,
         *     ACCESS_MASK dwDesiredAccess, LPSECURITY_ATTRIBUTES lpsa), and the W form
         */
        CreateWindowStationA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>createStation(args, false),
        },
        CreateWindowStationW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>createStation(args, true),
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
            handler: ([handle])=>{
                const entry = named(handle, 'station');
                if (!entry)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                processStation = entry.object;
                return 1;
            },
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
