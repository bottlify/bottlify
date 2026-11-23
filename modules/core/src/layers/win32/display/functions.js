/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a desktop program asks of the display's surroundings at start: its
 * DPI awareness and a monitor's DPI (shcore), the desktop window manager's
 * attributes of a window (dwmapi), and which session it runs in (wtsapi32).
 *
 * The machine has one monitor at 96 DPI, composition always on as from
 * Windows 8, and one console session, active. A window's frame bounds are
 * its rectangle; the rest of the window manager's attributes are kept as a
 * program sets them and change nothing drawn.
 */

import { processAwareness, setProcessAwareness } from '../user32/dpi.js';
import { pointerWidth, wholeAddress } from '../common/pointers.js';

const S_OK = 0;

const E_INVALIDARG = 0x80070057 | 0;
const E_ACCESSDENIED = 0x80070005 | 0;

/** PROCESS_DPI_AWARENESS: unaware, system aware, per-monitor aware. */
const PROCESS_PER_MONITOR_DPI_AWARE = 2;
const STANDARD_DPI = 96;
/** DWMWINDOWATTRIBUTE's EXTENDED_FRAME_BOUNDS and CLOAKED. */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const DWMWA_LAST = 38;
/**
 * DWM_TIMING_INFO, packed to a byte: its size, and where the fields answered
 * are - rateRefresh, qpcRefreshPeriod, rateCompose, qpcVBlank, cRefresh,
 * qpcCompose, cFrame.
 */
const DWM_TIMING_INFO_SIZE = 292;
const TIMING = { RATE_REFRESH: 4, REFRESH_PERIOD: 12, RATE_COMPOSE: 20, VBLANK: 28,
    REFRESH: 36, COMPOSE: 48, FRAME: 56 };

/** WTS_INFO_CLASS's classes answered, and WTS_CONNECTSTATE_CLASS's WTSActive. */
const WTS_SESSION_ID = 4;
const WTS_USER_NAME = 5;
const WTS_WINSTATION_NAME = 6;
const WTS_DOMAIN_NAME = 7;
const WTS_CONNECT_STATE = 8;
const WTS_CLIENT_PROTOCOL_TYPE = 16;
const WTS_ACTIVE = 0;
const WTS_CURRENT_SESSION = 0xffffffff;
const WTS_DISCONNECTED = 4;
const ERROR_NO_TOKEN = 1008;
const ERROR_INVALID_PARAMETER = 87;

/**
 * @typedef {Object} DisplayHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(hwnd: number, out: number) => number} windowRect  GetWindowRect
 * @property {(bytes: number) => number} allocate  memory WTSFreeMemory gives back
 * @property {(address: number) => void} free
 * @property {string} userName
 * @property {string} computerName
 * @property {import('../user32/dpi.js').DpiState} dpi  the process's awareness, user32's too
 * @property {number} refresh  the display's rate, Hz
 * @property {() => number} now  QueryPerformanceCounter's clock, milliseconds
 * @property {number} performanceFrequency  QueryPerformanceFrequency's answer
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process, whose out-pointers and
 *           WTS_SESSION_INFO's name are quadwords
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {DisplayHost} host */
export function createShcoreFunctions(host){
    return {
        /** HRESULT SetProcessDpiAwareness(PROCESS_DPI_AWARENESS value): once a process. */
        SetProcessDpiAwareness: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                if (wholeAddress(value) > PROCESS_PER_MONITOR_DPI_AWARE)
                {
                    return E_INVALIDARG;
                }
                return setProcessAwareness(host.dpi, wholeAddress(value)) ? S_OK : E_ACCESSDENIED;
            },
        },

        /** HRESULT GetProcessDpiAwareness(HANDLE hprocess, PROCESS_DPI_AWARENESS *value) */
        GetProcessDpiAwareness: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if (wholeAddress(out) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(wholeAddress(out), dword(processAwareness(host.dpi)));
                return S_OK;
            },
        },

        /**
         * HRESULT GetDpiForMonitor(HMONITOR hmonitor, MONITOR_DPI_TYPE dpiType,
         *     UINT *dpiX, UINT *dpiY): the one monitor's 96, whatever is asked.
         */
        GetDpiForMonitor: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, type, x, y])=>{
                if ((type >>> 0) > 2 || wholeAddress(x) === 0 || wholeAddress(y) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(wholeAddress(x), dword(STANDARD_DPI));
                host.writeMemory(wholeAddress(y), dword(STANDARD_DPI));
                return S_OK;
            },
        },

        /** HRESULT GetScaleFactorForMonitor(HMONITOR, DEVICE_SCALE_FACTOR *): 100 per cent. */
        GetScaleFactorForMonitor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if (wholeAddress(out) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(wholeAddress(out), dword(100));
                return S_OK;
            },
        },
    };
}

/**
 * dwmapi's exports a program may import by number alone; 102 is also
 * exported by name, and a benchmark links it this way.
 *
 * @type {Record<number, string>}
 */
export const DWMAPI_ORDINALS = { 102: 'DwmEnableComposition' };

/** @param {DisplayHost} host */
export function createDwmapiFunctions(host){
    /** What a program set, by window and attribute, read back as it was. @type {Map<string, Uint8Array>} */
    const set = new Map();
    return {
        /** HRESULT DwmIsCompositionEnabled(BOOL *pfEnabled): always on, as from Windows 8. */
        DwmIsCompositionEnabled: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if (wholeAddress(out) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(wholeAddress(out), dword(1));
                return S_OK;
            },
        },

        /**
         * HRESULT DwmGetWindowAttribute(HWND hwnd, DWORD dwAttribute, PVOID pvAttribute,
         *     DWORD cbAttribute)
         *
         * The frame bounds are the window's rectangle, no window is cloaked,
         * and an attribute set is read back as set.
         */
        DwmGetWindowAttribute: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, attribute, out, size])=>{
                const which = wholeAddress(attribute);
                if (wholeAddress(out) === 0 || which === 0 || which > DWMWA_LAST)
                {
                    return E_INVALIDARG;
                }
                if (which === DWMWA_EXTENDED_FRAME_BOUNDS)
                {
                    if ((size >>> 0) < 16)
                    {
                        return E_INVALIDARG;
                    }
                    return host.windowRect(hwnd >>> 0, wholeAddress(out)) ? S_OK : E_INVALIDARG;
                }
                const kept = set.get(`${hwnd >>> 0}:${which}`)
                    ?? (which === DWMWA_CLOAKED ? dword(0) : null);
                if (!kept || (size >>> 0) < kept.length)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(wholeAddress(out), kept);
                return S_OK;
            },
        },

        /** HRESULT DwmSetWindowAttribute(HWND, DWORD, LPCVOID, DWORD): kept, nothing drawn. */
        DwmSetWindowAttribute: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, attribute, value, size])=>{
                if (wholeAddress(value) === 0 || (attribute >>> 0) === 0
                    || (attribute >>> 0) > DWMWA_LAST)
                {
                    return E_INVALIDARG;
                }
                set.set(`${hwnd >>> 0}:${attribute >>> 0}`,
                    host.readMemory(wholeAddress(value), Math.min(size >>> 0, 64)).slice());
                return S_OK;
            },
        },

        /** HRESULT DwmExtendFrameIntoClientArea(HWND, const MARGINS *): the frame is not drawn apart. */
        DwmExtendFrameIntoClientArea: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, margins])=>(wholeAddress(margins) === 0 ? E_INVALIDARG : S_OK),
        },

        /** BOOL DwmDefWindowProc(HWND, UINT, WPARAM, LPARAM, LRESULT *): nothing is its to handle. */
        DwmDefWindowProc: {
            argBytes: 20,
            handler: ()=>0,
        },

        /**
         * HRESULT DwmGetCompositionTimingInfo(HWND hwnd, DWM_TIMING_INFO *info)
         *
         * The composition's refresh, as a renderer that paces itself on it
         * (WPF) reads it: the display's rate, the period and the last vertical
         * blank on QueryPerformanceCounter's clock, and the refreshes so far.
         * The window manager composes every refresh, so the frame counts are
         * the refresh counts; what it does not keep (pixels, late frames) is 0.
         * hwnd must be NULL, as from Windows 8.1.
         */
        DwmGetCompositionTimingInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, info])=>{
                if ((hwnd >>> 0) !== 0 || wholeAddress(info) === 0
                    || new DataView(host.readMemory(wholeAddress(info), 4).slice().buffer)
                        .getUint32(0, true) !== DWM_TIMING_INFO_SIZE)
                {
                    return E_INVALIDARG;
                }
                const ticks = BigInt(Math.round(host.now() * host.performanceFrequency / 1000));
                const period = BigInt(Math.round(host.performanceFrequency / host.refresh));
                const refreshes = ticks / period;
                const vblank = refreshes * period;
                const bytes = new Uint8Array(DWM_TIMING_INFO_SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, DWM_TIMING_INFO_SIZE, true);
                for (const at of [TIMING.RATE_REFRESH, TIMING.RATE_COMPOSE])
                {
                    view.setUint32(at, host.refresh, true);
                    view.setUint32(at + 4, 1, true);
                }
                view.setBigUint64(TIMING.REFRESH_PERIOD, period, true);
                view.setBigUint64(TIMING.VBLANK, vblank, true);
                view.setBigUint64(TIMING.REFRESH, refreshes, true);
                view.setBigUint64(TIMING.COMPOSE, vblank, true);
                view.setBigUint64(TIMING.FRAME, refreshes, true);
                host.writeMemory(wholeAddress(info), bytes);
                return S_OK;
            },
        },

        /** HRESULT DwmFlush(void) */
        DwmFlush: { argBytes: 0, handler: ()=>S_OK },

        /**
         * HRESULT DwmEnableComposition(UINT uCompositionAction): S_OK and
         * nothing changes, as from Windows 8, where composition cannot be
         * turned off - DwmIsCompositionEnabled above says the same.
         */
        DwmEnableComposition: { argBytes: 4, handler: ()=>S_OK },

        /**
         * HRESULT DwmEnableMMCSS(BOOL fEnableMMCSS): the window manager's
         * multimedia scheduling, which has no thread here to raise. S_OK, as
         * a program that looks it up calls it without checking the lookup.
         */
        DwmEnableMMCSS: { argBytes: 4, handler: ()=>S_OK },
    };
}

/**
 * The sessions of WTSAPI32: the one user's console, session 1, active, and
 * session 0 beside it, the services', disconnected, as Windows from Vista has
 * them.
 *
 * @param {DisplayHost & { userToken?: (out: number) => boolean }} host
 *     `userToken` writes the one user's token into `out` (OpenProcessToken's).
 */
export function createSessionInformationFunctions(host){
    const pointer = pointerWidth(host.pointerSize);
    /**
     * WTS_SESSION_INFO: SessionId, then pWinStationName at its alignment, then
     * State, the whole padded to a pointer.
     */
    const SESSION = pointer.size === 8 ? { name: 8, state: 16, size: 24 }
        : { name: 4, state: 8, size: 12 };
    /** @param {string} text @param {boolean} wide */
    const textBytes = (text, wide)=>{
        const data = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
        [...text].forEach((ch, i)=>{
            if (wide)
            {
                data[i * 2] = ch.charCodeAt(0) & 0xff;
                data[i * 2 + 1] = ch.charCodeAt(0) >>> 8;
            }
            else
            {
                data[i] = ch.charCodeAt(0) & 0xff;
            }
        });
        return data;
    };

    /**
     * WTSQuerySessionInformation in either width.
     *
     * @param {boolean} wide
     */
    const querySession = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([, session, kind, out, returned])=>{
            if ((out >>> 0) === 0 || (returned >>> 0) === 0
                || ((session >>> 0) !== WTS_CURRENT_SESSION && (session >>> 0) !== 1))
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            /** @type {Uint8Array} */
            let bytes;
            switch (kind >>> 0)
            {
                case WTS_SESSION_ID: bytes = dword(1); break;
                case WTS_CONNECT_STATE: bytes = dword(WTS_ACTIVE); break;
                case WTS_CLIENT_PROTOCOL_TYPE: bytes = Uint8Array.of(0, 0); break;
                case WTS_USER_NAME: bytes = textBytes(host.userName, wide); break;
                case WTS_WINSTATION_NAME: bytes = textBytes('Console', wide); break;
                case WTS_DOMAIN_NAME: bytes = textBytes(host.computerName, wide); break;
                default:
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
            }
            const block = host.allocate(bytes.length);
            if (block === 0)
            {
                return 0;
            }
            host.writeMemory(block, bytes);
            host.writeMemory(wholeAddress(out), pointer.bytes(block));
            host.writeMemory(wholeAddress(returned), dword(bytes.length));
            return 1;
        },
    });

    /**
     * WTSEnumerateSessions in either width: WTS_SESSION_INFO for the services'
     * session and the console's, their names after the array, all one block
     * WTSFreeMemory gives back.
     *
     * @param {boolean} wide
     */
    const enumerateSessions = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([, reserved, version, out, count])=>{
            if ((reserved >>> 0) !== 0 || (version >>> 0) !== 1 || (out >>> 0) === 0
                || (count >>> 0) === 0)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const sessions = [{ id: 0, name: 'Services', state: WTS_DISCONNECTED },
                { id: 1, name: 'Console', state: WTS_ACTIVE }];
            const names = sessions.map(one=>textBytes(one.name, wide));
            const size = sessions.length * SESSION.size
                + names.reduce((sum, one)=>sum + one.length, 0);
            const block = host.allocate(size);
            if (block === 0)
            {
                return 0;
            }
            let text = block + sessions.length * SESSION.size;
            sessions.forEach((one, at)=>{
                const entry = block + at * SESSION.size;
                host.writeMemory(entry, dword(one.id));
                host.writeMemory(entry + SESSION.name, pointer.bytes(text));
                host.writeMemory(entry + SESSION.state, dword(one.state));
                host.writeMemory(text, names[at]);
                text += names[at].length;
            });
            host.writeMemory(wholeAddress(out), pointer.bytes(block));
            host.writeMemory(wholeAddress(count), dword(sessions.length));
            return 1;
        },
    });

    return {
        /**
         * BOOL WTSQuerySessionInformation(HANDLE hServer, DWORD SessionId,
         *     WTS_INFO_CLASS WTSInfoClass, LPTSTR *ppBuffer, DWORD *pBytesReturned)
         *
         * The console session, 1, active, the machine's one user's; the
         * buffer is WTSFreeMemory's to give back.
         */
        WTSQuerySessionInformationA: querySession(false),
        WTSQuerySessionInformationW: querySession(true),

        /**
         * BOOL WTSEnumerateSessions(HANDLE hServer, DWORD Reserved, DWORD Version,
         *     PWTS_SESSION_INFO *ppSessionInfo, DWORD *pCount)
         */
        WTSEnumerateSessionsA: enumerateSessions(false),
        WTSEnumerateSessionsW: enumerateSessions(true),

        /**
         * BOOL WTSQueryUserToken(ULONG SessionId, PHANDLE phToken)
         *
         * The token of the user signed in to the session: the console's, which
         * is the machine's one user, whose token every process has. A service
         * asks it to start a program as that user. Another session has no user:
         * ERROR_NO_TOKEN.
         */
        WTSQueryUserToken: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([session, out])=>{
                if (wholeAddress(out) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                if ((session >>> 0) !== 1 || !host.userToken)
                {
                    host.setLastError(ERROR_NO_TOKEN);
                    return 0;
                }
                return host.userToken(wholeAddress(out)) ? 1 : 0;
            },
        },

        /** void WTSFreeMemory(PVOID pMemory) */
        WTSFreeMemory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                if (wholeAddress(address) !== 0)
                {
                    host.free(wholeAddress(address));
                }
                return 0;
            },
        },
    };
}

