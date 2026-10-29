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

const S_OK = 0;

const E_INVALIDARG = 0x80070057 | 0;
const E_ACCESSDENIED = 0x80070005 | 0;
const DWM_E_COMPOSITIONDISABLED = 0x80263001 | 0;

/** PROCESS_DPI_AWARENESS: unaware, system aware, per-monitor aware. */
const PROCESS_PER_MONITOR_DPI_AWARE = 2;
const STANDARD_DPI = 96;
/** DWMWINDOWATTRIBUTE's EXTENDED_FRAME_BOUNDS and CLOAKED. */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const DWMWA_LAST = 38;

/** WTS_INFO_CLASS's classes answered, and WTS_CONNECTSTATE_CLASS's WTSActive. */
const WTS_SESSION_ID = 4;
const WTS_USER_NAME = 5;
const WTS_WINSTATION_NAME = 6;
const WTS_DOMAIN_NAME = 7;
const WTS_CONNECT_STATE = 8;
const WTS_CLIENT_PROTOCOL_TYPE = 16;
const WTS_ACTIVE = 0;
const WTS_CURRENT_SESSION = 0xffffffff;
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
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {DisplayHost} host */
export function createShcoreFunctions(host){
    /** The awareness the process set, once; null until it does. @type {number | null} */
    let awareness = null;
    return {
        /** HRESULT SetProcessDpiAwareness(PROCESS_DPI_AWARENESS value): once a process. */
        SetProcessDpiAwareness: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                if ((value >>> 0) > PROCESS_PER_MONITOR_DPI_AWARE)
                {
                    return E_INVALIDARG;
                }
                if (awareness !== null)
                {
                    return E_ACCESSDENIED;
                }
                awareness = value >>> 0;
                return S_OK;
            },
        },

        /** HRESULT GetProcessDpiAwareness(HANDLE hprocess, PROCESS_DPI_AWARENESS *value) */
        GetProcessDpiAwareness: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, dword(awareness ?? 0));
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
                if ((type >>> 0) > 2 || (x >>> 0) === 0 || (y >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(x >>> 0, dword(STANDARD_DPI));
                host.writeMemory(y >>> 0, dword(STANDARD_DPI));
                return S_OK;
            },
        },

        /** HRESULT GetScaleFactorForMonitor(HMONITOR, DEVICE_SCALE_FACTOR *): 100 per cent. */
        GetScaleFactorForMonitor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, dword(100));
                return S_OK;
            },
        },
    };
}

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
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, dword(1));
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
                const which = attribute >>> 0;
                if ((out >>> 0) === 0 || which === 0 || which > DWMWA_LAST)
                {
                    return E_INVALIDARG;
                }
                if (which === DWMWA_EXTENDED_FRAME_BOUNDS)
                {
                    if ((size >>> 0) < 16)
                    {
                        return E_INVALIDARG;
                    }
                    return host.windowRect(hwnd >>> 0, out >>> 0) ? S_OK : E_INVALIDARG;
                }
                const kept = set.get(`${hwnd >>> 0}:${which}`)
                    ?? (which === DWMWA_CLOAKED ? dword(0) : null);
                if (!kept || (size >>> 0) < kept.length)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, kept);
                return S_OK;
            },
        },

        /** HRESULT DwmSetWindowAttribute(HWND, DWORD, LPCVOID, DWORD): kept, nothing drawn. */
        DwmSetWindowAttribute: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, attribute, value, size])=>{
                if ((value >>> 0) === 0 || (attribute >>> 0) === 0
                    || (attribute >>> 0) > DWMWA_LAST)
                {
                    return E_INVALIDARG;
                }
                set.set(`${hwnd >>> 0}:${attribute >>> 0}`,
                    host.readMemory(value >>> 0, Math.min(size >>> 0, 64)).slice());
                return S_OK;
            },
        },

        /** HRESULT DwmExtendFrameIntoClientArea(HWND, const MARGINS *): the frame is not drawn apart. */
        DwmExtendFrameIntoClientArea: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, margins])=>((margins >>> 0) === 0 ? E_INVALIDARG : S_OK),
        },

        /** BOOL DwmDefWindowProc(HWND, UINT, WPARAM, LPARAM, LRESULT *): nothing is its to handle. */
        DwmDefWindowProc: {
            argBytes: 20,
            handler: ()=>0,
        },

        /**
         * HRESULT DwmGetCompositionTimingInfo(HWND, DWM_TIMING_INFO *): the
         * window manager's timing is not kept here; a program falls back to
         * its own clock.
         */
        DwmGetCompositionTimingInfo: {
            argBytes: 8,
            handler: ()=>DWM_E_COMPOSITIONDISABLED,
        },

        /** HRESULT DwmFlush(void) */
        DwmFlush: { argBytes: 0, handler: ()=>S_OK },
    };
}

/** @param {DisplayHost} host */
export function createSessionInformationFunctions(host){
    return {
        /**
         * BOOL WTSQuerySessionInformationW(HANDLE hServer, DWORD SessionId,
         *     WTS_INFO_CLASS WTSInfoClass, LPWSTR *ppBuffer, DWORD *pBytesReturned)
         *
         * The console session, 1, active, the machine's one user's; the
         * buffer is WTSFreeMemory's to give back.
         */
        WTSQuerySessionInformationW: {
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
                /** @param {string} text */
                const wide = text=>{
                    const data = new Uint8Array((text.length + 1) * 2);
                    [...text].forEach((ch, i)=>{
                        data[i * 2] = ch.charCodeAt(0) & 0xff;
                        data[i * 2 + 1] = ch.charCodeAt(0) >>> 8;
                    });
                    return data;
                };
                switch (kind >>> 0)
                {
                    case WTS_SESSION_ID: bytes = dword(1); break;
                    case WTS_CONNECT_STATE: bytes = dword(WTS_ACTIVE); break;
                    case WTS_CLIENT_PROTOCOL_TYPE: bytes = Uint8Array.of(0, 0); break;
                    case WTS_USER_NAME: bytes = wide(host.userName); break;
                    case WTS_WINSTATION_NAME: bytes = wide('Console'); break;
                    case WTS_DOMAIN_NAME: bytes = wide(host.computerName); break;
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
                host.writeMemory(out >>> 0, dword(block));
                host.writeMemory(returned >>> 0, dword(bytes.length));
                return 1;
            },
        },

        /** void WTSFreeMemory(PVOID pMemory) */
        WTSFreeMemory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                if ((address >>> 0) !== 0)
                {
                    host.free(address >>> 0);
                }
                return 0;
            },
        },
    };
}


/**
 * DWrite: the text and font system's factory, which a browser asks for first
 * of all its font calls. DirectWrite is not provided: the factory is refused
 * with E_NOTIMPL and its out pointer cleared, as on a system without the
 * component, and the refusal is said once.
 *
 * @param {Pick<DisplayHost, 'writeMemory'>
 *     & { divergence?: (api: string, detail: string) => void }} host
 */
export function createDwriteFunctions(host){
    let said = false;
    return {
        /** HRESULT DWriteCreateFactory(DWRITE_FACTORY_TYPE, REFIID, IUnknown **factory) */
        DWriteCreateFactory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, dword(0));
                }
                if (!said)
                {
                    said = true;
                    host.divergence?.('DWriteCreateFactory', 'DirectWrite is not provided');
                }
                return 0x80004001 | 0;
            },
        },
    };
}
