/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program asks the system about itself: how big the screen is, what
 * colour a button is, where the cursor is, which display modes exist.
 *
 * Every one of these has a wrong answer that costs more than no answer. A
 * metric that contradicts the screen the build was configured for makes a game
 * centre its window off the edge of it. A display enumeration that never ends
 * hangs the loop that walks it. A key state that changes when nothing pressed a
 * key makes a program act on input that never happened. So the rule here is
 * that everything is derived from one configured screen, enumeration
 * terminates, and input reports nothing rather than something invented -- the
 * input layer is a stub in this build, and saying "no key is down" is true.
 */

import { formatToString } from '../msvcrt/format.js';
import {
    DEVMODEA,
    DM_BITSPERPEL,
    DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT,
    DM_PELSWIDTH,
    MONITORINFO,
    WINDOWINFO,
    WINDOWPLACEMENT,
    readRect,
    writeRect,
    writeU16,
    writeU32s,
} from './structs.js';

/** GetSystemMetrics indices this build has a real answer for. */
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_CXVSCROLL = 2;
const SM_CYHSCROLL = 3;
const SM_CYCAPTION = 4;
const SM_CXBORDER = 5;
const SM_CYBORDER = 6;
const SM_CXFIXEDFRAME = 7;
const SM_CYFIXEDFRAME = 8;
const SM_CYMENU = 15;
const SM_CXFULLSCREEN = 16;
const SM_CYFULLSCREEN = 17;
const SM_CXSIZEFRAME = 32;
const SM_CYSIZEFRAME = 33;
const SM_CMONITORS = 80;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** The frame a window with a caption and a sizing border carries. */
const BORDER = 1;
const CAPTION_HEIGHT = 19;
const SIZE_FRAME = 4;
const MENU_HEIGHT = 19;
const SCROLLBAR = 16;

/** Window styles that decide how much frame AdjustWindowRect has to add. */
const WS_BORDER = 0x00800000;
const WS_DLGFRAME = 0x00400000;
const WS_THICKFRAME = 0x00040000;
const WS_CAPTION = WS_BORDER | WS_DLGFRAME;

/**
 * Extended styles that add frame of their own. They are the reason
 * AdjustWindowRectEx exists as a separate call from AdjustWindowRect: a client
 * rectangle grown without them comes out short by the edge on every side, and a
 * program that sized a window this way gets a client area smaller than it asked
 * for, which is invisible until something is clipped.
 */
const WS_EX_DLGMODALFRAME = 0x00000001;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_WINDOWEDGE = 0x00000100;
const WS_EX_CLIENTEDGE = 0x00000200;
const WS_EX_STATICEDGE = 0x00020000;

/** A tool window's caption is shorter than an ordinary one's. */
const TOOL_CAPTION_HEIGHT = 12;

/**
 * The system colours, as a program reads them: COLORREF, 0x00BBGGRR.
 *
 * @type {Record<number, number>}
 */
const SYS_COLORS = Object.freeze({
    0: 0x00c0c0c0,
    1: 0x00808080,
    2: 0x00000080,
    4: 0x00c0c0c0,
    5: 0x00ffffff,
    6: 0x00000000,
    7: 0x00000000,
    8: 0x00000000,
    13: 0x00800000,
    14: 0x00ffffff,
    15: 0x00c0c0c0,
    16: 0x00808080,
    17: 0x00808080,
    18: 0x00000000,
    20: 0x00ffffff,
    21: 0x00808080,
});

/** MonitorFromRect and friends answer with this, there being one display. */
const PRIMARY_MONITOR = 0x00010001;
const MONITORINFOF_PRIMARY = 1;

/** GetWindow's relations. */
const GW_HWNDFIRST = 0;
const GW_HWNDLAST = 1;
const GW_HWNDNEXT = 2;
const GW_HWNDPREV = 3;
const GW_OWNER = 4;
const GW_CHILD = 5;

/**
 * GetClassLong / SetClassLong indices. They are negative for the same reason
 * the window ones are: a non-negative index addresses the class extra bytes,
 * and a named field has to sit somewhere no offset can reach.
 */
const GCL_MENUNAME = -8;
const GCL_HBRBACKGROUND = -10;
const GCL_HCURSOR = -12;
const GCL_HICON = -14;
const GCL_HMODULE = -16;
const GCL_CBWNDEXTRA = -18;
const GCL_CBCLSEXTRA = -20;
const GCL_WNDPROC = -24;
const GCL_STYLE = -26;
const GCW_ATOM = -32;
const GCL_HICONSM = -34;

/** The style bit EnableWindow sets, and the only one it touches. */
const WS_DISABLED = 0x08000000;

/** A class or window name is at most this long. */
const MAX_NAME = 256;

/** ChangeDisplaySettingsEx succeeds only for the mode already in effect. */
const DISP_CHANGE_SUCCESSFUL = 0;
const DISP_CHANGE_BADMODE = -2;

/** The refresh rate reported for the one mode this build offers. */
const REFRESH_HZ = 60;

/**
 * Builds the system-query half of user32, over the window records the
 * bookkeeping half keeps.
 *
 * @param {Object} options
 * @param {any} options.host
 * @param {(hwnd: number) => any | null} options.live
 * @param {Map<number, any>} options.windows
 * @param {Map<string, any>} options.classes  Registered classes, by name.
 */
export function createSystemFunctions({ host, live, windows, classes }){
    const screen = host.screen ?? { width: 640, height: 480, bitsPerPixel: 32 };

    /** The window that has the mouse, shared by SetCapture and ReleaseCapture. */
    let captured = 0;

    /** Windows in creation order, which is the only order this build has. */
    const ordered = ()=>[...windows.values()].filter(record=>!record.destroyed);

    /** @param {number} hwnd @returns {any | null} the class a window was made from */
    const classOfWindow = hwnd=>{
        const record = live(hwnd);
        return record ? classes.get(record.className) ?? null : null;
    };

    /** @param {any} cls @param {number} index */
    const readClassLong = (cls, index)=>{
        switch (index | 0){
            case GCL_STYLE:
                return cls.style;
            case GCL_WNDPROC:
                return cls.wndProc;
            case GCL_CBCLSEXTRA:
                return cls.classExtra;
            case GCL_CBWNDEXTRA:
                return cls.windowExtra;
            case GCL_HMODULE:
                return cls.instance;
            case GCL_HICON:
                return cls.icon;
            case GCL_HICONSM:
                return cls.iconSm;
            case GCL_HCURSOR:
                return cls.cursor;
            case GCL_HBRBACKGROUND:
                return cls.background;
            case GCL_MENUNAME:
                return cls.menuName;
            case GCW_ATOM:
                return cls.atom;
            default:
                break;
        }
        const at = index | 0;
        // Class extra bytes are storage the class asked for. Reading outside
        // them would be reading whatever happens to follow in our own record.
        cls.extra ??= new DataView(new ArrayBuffer(Math.max(cls.classExtra, 0)));
        return at >= 0 && at + 4 <= cls.extra.byteLength ? cls.extra.getUint32(at, true) : 0;
    };

    /** @param {any} cls @param {number} index @param {number} value */
    const writeClassLong = (cls, index, value)=>{
        switch (index | 0){
            case GCL_STYLE:
                cls.style = value >>> 0;
                return;
            case GCL_WNDPROC:
                cls.wndProc = value >>> 0;
                return;
            case GCL_HICON:
                cls.icon = value >>> 0;
                return;
            case GCL_HICONSM:
                cls.iconSm = value >>> 0;
                return;
            case GCL_HCURSOR:
                cls.cursor = value >>> 0;
                return;
            case GCL_HBRBACKGROUND:
                cls.background = value >>> 0;
                return;
            case GCL_MENUNAME:
                cls.menuName = value >>> 0;
                return;
            case GCL_HMODULE:
                cls.instance = value >>> 0;
                return;
            default:
                break;
        }
        const at = index | 0;
        cls.extra ??= new DataView(new ArrayBuffer(Math.max(cls.classExtra, 0)));
        if (at >= 0 && at + 4 <= cls.extra.byteLength)
        {
            cls.extra.setUint32(at, value >>> 0, true);
        }
    };

    /** @param {number} address @param {string} text @param {number} limit */
    const writeString = (address, text, limit)=>{
        const clipped = limit > 0 ? text.slice(0, limit - 1) : '';
        const bytes = new Uint8Array(clipped.length + 1);
        for (let index = 0; index < clipped.length; index++)
        {
            bytes[index] = clipped.charCodeAt(index) & 0xff;
        }
        host.writeMemory(address, bytes);
        return clipped.length;
    };

    /** @param {number} style @param {number} exStyle */
    const frameOf = (style, exStyle = 0)=>{
        const thick = (style & WS_THICKFRAME) !== 0;
        const border = (style & (WS_BORDER | WS_DLGFRAME)) !== 0;
        const modal = (exStyle & WS_EX_DLGMODALFRAME) !== 0;
        const windowEdge = (exStyle & (WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE)) !== 0;
        const staticEdge = (exStyle & WS_EX_STATICEDGE) !== 0;

        // The edges add up rather than replace one another: a sizing border and
        // a client edge are two separate frames drawn one inside the other.
        let edge = thick ? SIZE_FRAME : border || modal ? BORDER : 0;
        edge += windowEdge ? 2 * BORDER : 0;
        edge += staticEdge ? BORDER : 0;

        const captioned = (style & WS_CAPTION) === WS_CAPTION;
        const caption = (exStyle & WS_EX_TOOLWINDOW) !== 0
            ? TOOL_CAPTION_HEIGHT
            : CAPTION_HEIGHT;
        return {
            left: edge,
            top: edge + (captioned ? caption : 0),
            right: edge,
            bottom: edge,
        };
    };

    /**
     * The one implementation both ChangeDisplaySettings entry points call.
     *
     * The one mode on offer is the one already in effect, so asking for it
     * succeeds and asking for another fails. A build that reported success for
     * a mode it did not switch to would have every later metric disagree with
     * what the program believes.
     *
     * @param {number} devMode
     */
    const changeDisplaySettings = devMode=>{
        if ((devMode >>> 0) === 0)
        {
            // A null mode means "go back to what the registry says", which here
            // is what is already on the screen.
            return DISP_CHANGE_SUCCESSFUL;
        }
        const wanted = host.readMemory(devMode + DEVMODEA.dmPelsWidth, 8);
        const width = (wanted[0] | wanted[1] << 8 | wanted[2] << 16
            | wanted[3] << 24) >>> 0;
        const height = (wanted[4] | wanted[5] << 8 | wanted[6] << 16
            | wanted[7] << 24) >>> 0;
        return width === screen.width && height === screen.height
            ? DISP_CHANGE_SUCCESSFUL
            : DISP_CHANGE_BADMODE;
    };

    /**
     * The one implementation both AdjustWindowRect entry points call.
     *
     * Named rather than reached through `this` from inside the table below: an
     * object literal's methods can see each other at run time but nothing can
     * check that they do, and a renamed entry point would fail at the call
     * rather than at the rename.
     *
     * @param {number} rect @param {number} style @param {number} menu
     * @param {number} exStyle
     */
    const adjustWindowRect = (rect, style, menu, exStyle)=>{
        if ((rect >>> 0) === 0)
        {
            return 0;
        }
        const bounds = readRect(host, rect);
        const frame = frameOf(style >>> 0, exStyle >>> 0);
        writeRect(host, rect, {
            left: bounds.left - frame.left,
            top: bounds.top - frame.top - ((menu >>> 0) !== 0 ? MENU_HEIGHT : 0),
            right: bounds.right + frame.right,
            bottom: bounds.bottom + frame.bottom,
        });
        return 1;
    };

    /** @param {number} index */
    const metric = index=>{
        switch (index | 0){
            case SM_CXSCREEN:
            case SM_CXFULLSCREEN:
            case SM_CXVIRTUALSCREEN:
                return screen.width;
            case SM_CYSCREEN:
            case SM_CYVIRTUALSCREEN:
                return screen.height;
            // The usable height is the screen less the frame a full-screen
            // window still carries, which is what a program subtracts for.
            case SM_CYFULLSCREEN:
                return screen.height - CAPTION_HEIGHT - 2 * BORDER;
            case SM_CXBORDER:
            case SM_CYBORDER:
                return BORDER;
            case SM_CYCAPTION:
                return CAPTION_HEIGHT;
            case SM_CXFIXEDFRAME:
            case SM_CYFIXEDFRAME:
                return BORDER;
            case SM_CXSIZEFRAME:
            case SM_CYSIZEFRAME:
                return SIZE_FRAME;
            case SM_CYMENU:
                return MENU_HEIGHT;
            case SM_CXVSCROLL:
            case SM_CYHSCROLL:
                return SCROLLBAR;
            case SM_CMONITORS:
                return 1;
            default:
                return 0;
        }
    };

    return {
        /** int GetSystemMetrics(int nIndex) */
        GetSystemMetrics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>metric(index),
        },

        /** DWORD GetSysColor(int nIndex) */
        GetSysColor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>SYS_COLORS[index | 0] ?? 0,
        },

        /**
         * HBRUSH GetSysColorBrush(int nIndex)
         *
         * A brush is a GDI object and this layer has no object table. Answering
         * null is what a program checks for, and it is true here.
         */
        GetSysColorBrush: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * BOOL SystemParametersInfoA(UINT uiAction, UINT uiParam, PVOID pvParam,
         *                            UINT fWinIni)
         *
         * Only the work area is answered, because it is the one a window uses to
         * place itself. Everything else reports failure rather than a default
         * that would contradict the screen above.
         */
        SystemParametersInfoA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([action, , value])=>{
                const SPI_GETWORKAREA = 0x0030;
                if ((action >>> 0) !== SPI_GETWORKAREA || (value >>> 0) === 0)
                {
                    return 0;
                }
                writeRect(host, value,
                    { left: 0, top: 0, right: screen.width, bottom: screen.height });
                return 1;
            },
        },

        /** HWND GetDesktopWindow(void) */
        GetDesktopWindow: {
            argBytes: 0,
            handler: ()=>0,
        },

        /** HMONITOR MonitorFromRect(LPCRECT lprc, DWORD dwFlags) */
        MonitorFromRect: {
            argBytes: 8,
            handler: ()=>PRIMARY_MONITOR,
        },

        /** HMONITOR MonitorFromWindow(HWND hwnd, DWORD dwFlags) */
        MonitorFromWindow: {
            argBytes: 8,
            handler: ()=>PRIMARY_MONITOR,
        },

        /**
         * BOOL GetMonitorInfoA(HMONITOR hMonitor, LPMONITORINFO lpmi)
         *
         * cbSize is the caller saying which structure it allocated; a size that
         * is neither of the two it may be is a caller bug, and answering FALSE is
         * how it finds out rather than by having its stack written past.
         */
        GetMonitorInfoA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([monitor, info])=>{
                if ((monitor >>> 0) !== PRIMARY_MONITOR || (info >>> 0) === 0)
                {
                    return 0;
                }
                const size = host.readMemory(info + MONITORINFO.cbSize, 4);
                const declared = (size[0] | size[1] << 8 | size[2] << 16 | size[3] << 24) >>> 0;
                if (declared < MONITORINFO.SIZE)
                {
                    return 0;
                }
                const whole = { left: 0, top: 0, right: screen.width, bottom: screen.height };
                writeRect(host, info + MONITORINFO.rcMonitor, whole);
                writeRect(host, info + MONITORINFO.rcWork, whole);
                writeU32s(host, info + MONITORINFO.dwFlags, [MONITORINFOF_PRIMARY]);
                return 1;
            },
        },

        /**
         * BOOL EnumDisplaySettingsA(LPCSTR lpszDeviceName, DWORD iModeNum,
         *                          DEVMODEA *lpDevMode)
         *
         * One mode, and index one answers FALSE. A caller walks this until it
         * does, so an enumeration that never ends is a hang rather than a wrong
         * list.
         */
        EnumDisplaySettingsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, mode, devMode])=>{
                if ((mode | 0) !== 0 || (devMode >>> 0) === 0)
                {
                    return 0;
                }
                writeU16(host, devMode + DEVMODEA.dmSize, DEVMODEA.SIZE);
                writeU16(host, devMode + DEVMODEA.dmDriverExtra, 0);
                writeU32s(host, devMode + DEVMODEA.dmFields,
                    [DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY]);
                writeU32s(host, devMode + DEVMODEA.dmBitsPerPel,
                    [screen.bitsPerPixel, screen.width, screen.height]);
                writeU32s(host, devMode + DEVMODEA.dmDisplayFrequency, [REFRESH_HZ]);
                return 1;
            },
        },

        /**
         * BOOL EnumDisplayDevicesA(LPCSTR lpDevice, DWORD iDevNum,
         *                         PDISPLAY_DEVICEA lpDisplayDevice, DWORD dwFlags)
         *
         * Not implemented: DISPLAY_DEVICEA carries four fixed-length strings
         * whose lengths differ between the ANSI and the wide form, and writing
         * them wrong is worse than saying there are no devices to enumerate.
         */
        EnumDisplayDevicesA: {
            argBytes: 16,
            handler: ()=>0,
        },

        /**
         * LONG ChangeDisplaySettingsExA(LPCSTR lpszDeviceName, DEVMODEA *lpDevMode,
         *                              HWND hwnd, DWORD dwflags, LPVOID lParam)
         *
         * The one mode on offer is the one already in effect, so asking for it
         * succeeds and asking for another fails. A build that reported success
         * for a mode it did not switch to would have every later metric disagree
         * with what the program believes.
         */
        ChangeDisplaySettingsExA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, devMode])=>changeDisplaySettings(devMode),
        },

        /**
         * LONG ChangeDisplaySettingsA(DEVMODEA *lpDevMode, DWORD dwFlags)
         *
         * The older two-argument spelling of the same thing, and the one a
         * program of this era actually calls when it goes full screen. Missing
         * it is not a missing feature: an import nobody wrote gets a stub that
         * cleans up no arguments, so the caller returns with its stack eight
         * bytes adrift and dies later in a stack-cookie check, a long way from
         * anything that would explain it.
         */
        ChangeDisplaySettingsA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([devMode])=>changeDisplaySettings(devMode),
        },

        /**
         * BOOL AdjustWindowRectEx(LPRECT lpRect, DWORD dwStyle, BOOL bMenu,
         *                        DWORD dwExStyle)
         *
         * Grows a client rectangle into the window rectangle that contains it,
         * which is how a program asks for a client area of an exact size.
         */
        AdjustWindowRectEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([rect, style, menu, exStyle])=>
                adjustWindowRect(rect, style, menu, exStyle),
        },

        /** BOOL AdjustWindowRect(LPRECT lpRect, DWORD dwStyle, BOOL bMenu) */
        AdjustWindowRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rect, style, menu])=>adjustWindowRect(rect, style, menu, 0),
        },

        /**
         * BOOL ClientToScreen(HWND hWnd, LPPOINT lpPoint)
         *
         * A window's client origin is its own position: there is one desktop and
         * no nesting of frames beyond what the record already knows.
         */
        ClientToScreen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, point])=>{
                const record = live(hwnd);
                if (!record || (point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.readMemory(point, 8);
                const x = (at[0] | at[1] << 8 | at[2] << 16 | at[3] << 24) | 0;
                const y = (at[4] | at[5] << 8 | at[6] << 16 | at[7] << 24) | 0;
                writeU32s(host, point, [x + record.x, y + record.y]);
                return 1;
            },
        },

        /** BOOL ScreenToClient(HWND hWnd, LPPOINT lpPoint) */
        ScreenToClient: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, point])=>{
                const record = live(hwnd);
                if (!record || (point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.readMemory(point, 8);
                const x = (at[0] | at[1] << 8 | at[2] << 16 | at[3] << 24) | 0;
                const y = (at[4] | at[5] << 8 | at[6] << 16 | at[7] << 24) | 0;
                writeU32s(host, point, [x - record.x, y - record.y]);
                return 1;
            },
        },

        /**
         * int MapWindowPoints(HWND hWndFrom, HWND hWndTo, LPPOINT lpPoints,
         *                    UINT cPoints)
         *
         * The return packs the offset applied: dx in the low word, dy in the
         * high one. A program uses that instead of the points when it only wants
         * the delta, so returning zero would be wrong even when the points are
         * right.
         */
        MapWindowPoints: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([from, to, points, count])=>{
                const source = live(from);
                const target = live(to);
                const dx = (source?.x ?? 0) - (target?.x ?? 0);
                const dy = (source?.y ?? 0) - (target?.y ?? 0);
                for (let index = 0; index < (count >>> 0); index++)
                {
                    const at = points + index * 8;
                    const bytes = host.readMemory(at, 8);
                    const x = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) | 0;
                    const y = (bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24) | 0;
                    writeU32s(host, at, [x + dx, y + dy]);
                }
                return ((dy & 0xffff) << 16 | (dx & 0xffff)) >>> 0;
            },
        },

        /** HWND GetParent(HWND hWnd) */
        GetParent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.parent ?? 0,
        },

        /** HWND SetParent(HWND hWndChild, HWND hWndNewParent) */
        SetParent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([child, parent])=>{
                const record = live(child);
                if (!record)
                {
                    return 0;
                }
                const previous = record.parent;
                record.parent = parent >>> 0;
                return previous;
            },
        },

        /** HWND GetWindow(HWND hWnd, UINT uCmd) */
        GetWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, command])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const siblings = ordered().filter(other=>other.parent === record.parent);
                const at = siblings.indexOf(record);
                switch (command >>> 0){
                    case GW_HWNDFIRST:
                        return siblings[0]?.hwnd ?? 0;
                    case GW_HWNDLAST:
                        return siblings[siblings.length - 1]?.hwnd ?? 0;
                    case GW_HWNDNEXT:
                        return siblings[at + 1]?.hwnd ?? 0;
                    case GW_HWNDPREV:
                        return at > 0 ? siblings[at - 1].hwnd : 0;
                    case GW_CHILD:
                        return ordered().find(other=>other.parent === record.hwnd)?.hwnd ?? 0;
                    case GW_OWNER:
                        return record.parent;
                    default:
                        return 0;
                }
            },
        },

        /** BOOL GetWindowInfo(HWND hwnd, PWINDOWINFO pwi) */
        GetWindowInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, info])=>{
                const record = live(hwnd);
                if (!record || (info >>> 0) === 0)
                {
                    return 0;
                }
                const frame = frameOf(record.style);
                writeRect(host, info + WINDOWINFO.rcWindow, {
                    left: record.x - frame.left,
                    top: record.y - frame.top,
                    right: record.x + record.width + frame.right,
                    bottom: record.y + record.height + frame.bottom,
                });
                writeRect(host, info + WINDOWINFO.rcClient, {
                    left: record.x,
                    top: record.y,
                    right: record.x + record.width,
                    bottom: record.y + record.height,
                });
                writeU32s(host, info + WINDOWINFO.dwStyle,
                    [record.style, record.exStyle, 0, frame.left, frame.top]);
                // Two WORDs share the last DWORD, so neither may be written as one.
                writeU16(host, info + WINDOWINFO.atomWindowType, 0);
                writeU16(host, info + WINDOWINFO.wCreatorVersion, 0x0400);
                return 1;
            },
        },

        /** BOOL GetWindowPlacement(HWND hWnd, WINDOWPLACEMENT *lpwndpl) */
        GetWindowPlacement: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, placement])=>{
                const record = live(hwnd);
                if (!record || (placement >>> 0) === 0)
                {
                    return 0;
                }
                const SW_SHOWNORMAL = 1;
                writeU32s(host, placement + WINDOWPLACEMENT.length,
                    [WINDOWPLACEMENT.SIZE, 0, SW_SHOWNORMAL]);
                writeU32s(host, placement + WINDOWPLACEMENT.ptMinPosition, [0, 0, 0, 0]);
                writeRect(host, placement + WINDOWPLACEMENT.rcNormalPosition, {
                    left: record.x,
                    top: record.y,
                    right: record.x + record.width,
                    bottom: record.y + record.height,
                });
                return 1;
            },
        },

        /** BOOL SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT *lpwndpl) */
        SetWindowPlacement: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, placement])=>{
                const record = live(hwnd);
                if (!record || (placement >>> 0) === 0)
                {
                    return 0;
                }
                const bounds = readRect(host, placement + WINDOWPLACEMENT.rcNormalPosition);
                record.x = bounds.left;
                record.y = bounds.top;
                record.width = bounds.right - bounds.left;
                record.height = bounds.bottom - bounds.top;
                return 1;
            },
        },

        /**
         * BOOL SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y,
         *                  int cx, int cy, UINT uFlags)
         *
         * The two flags that say "ignore what I passed" are the whole of the
         * behaviour worth having: a program moves without resizing and resizes
         * without moving by setting them, and honouring the arguments anyway
         * would put the window somewhere it never asked for.
         */
        SetWindowPos: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([hwnd, , x, y, cx, cy, flags])=>{
                const SWP_NOSIZE = 0x0001;
                const SWP_NOMOVE = 0x0002;
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                if ((flags & SWP_NOMOVE) === 0)
                {
                    record.x = x | 0;
                    record.y = y | 0;
                }
                if ((flags & SWP_NOSIZE) === 0)
                {
                    record.width = cx | 0;
                    record.height = cy | 0;
                }
                return 1;
            },
        },

        /** HWND BringWindowToTop(HWND hWnd) */
        BringWindowToTop: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
        },

        /** BOOL IsIconic(HWND hWnd) */
        IsIconic: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** BOOL IsZoomed(HWND hWnd) */
        IsZoomed: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** BOOL IsWindowEnabled(HWND hWnd) */
        IsWindowEnabled: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(live(hwnd) ? 1 : 0),
        },

        /** HWND WindowFromPoint(POINT Point) */
        WindowFromPoint: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * int wsprintfA(LPSTR lpOut, LPCSTR lpFmt, ...)
         *
         * cdecl, which is the part that matters: the caller pops the arguments,
         * and the count is whatever it pushed. Declaring it stdcall would have
         * the stub pop a fixed number and leave the guest's stack wrong, with
         * the failure appearing somewhere else entirely.
         *
         * argBytes here says how many stack slots to *read*, not how many to
         * pop -- a cdecl callee pops none. It has to cover the widest format a
         * program might use, because a slot not read is a conversion that gets
         * nothing, and the format string is what decides how many are actually
         * consumed. Reading past what the caller pushed is safe for the same
         * reason: those slots are never looked at. The same over-declaration
         * under stdcall would corrupt the stack, which is why this one is
         * spelled out rather than left to look like a mistake.
         */
        wsprintfA: {
            convention: 'cdecl',
            argBytes: 8 + 4 * 32,
            /** @param {number[]} args */
            handler: args=>{
                const readString = (/** @type {number} */ address)=>
                    (address >>> 0) === 0 ? '(null)' : host.readCString(address, 0x10000);
                const text = formatToString(readString(args[1]), args.slice(2), readString);
                return writeString(args[0], text, text.length + 1);
            },
        },

        /** BOOL MessageBeep(UINT uType) */
        MessageBeep: {
            argBytes: 4,
            handler: ()=>1,
        },

        /**
         * int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType)
         *
         * There is nobody to press a button, so this reports what a dialog does
         * when it is dismissed without a choice, and hands the text to whoever is
         * listening -- a message box is usually a program explaining why it is
         * about to stop, which is the most useful thing it will say.
         */
        MessageBoxA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, text, caption])=>{
                const IDOK = 1;
                const body = (text >>> 0) === 0 ? '' : host.readCString(text, 0x10000);
                const title = (caption >>> 0) === 0 ? '' : host.readCString(caption, 0x1000);
                host.say?.(title.length > 0 ? `${title}: ${body}` : body);
                return IDOK;
            },
        },

        /**
         * int LoadStringA(HINSTANCE hInstance, UINT uID, LPSTR lpBuffer,
         *                int cchBufferMax)
         *
         * The string lives in the module's resource directory, in a bundle of
         * sixteen. What comes back from there is UTF-16; this is the ANSI entry
         * point, so it is narrowed here rather than anywhere further in -- the
         * wide entry point wants the same string untouched.
         *
         * A zero buffer is not an error: it asks for the string's address, and
         * a program that passes one is reading the resource in place. Nothing
         * here can give it one, so it gets a length of zero, which is what a
         * caller checks.
         */
        LoadStringA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, id, buffer, size])=>{
                const text = host.loadString?.(instance >>> 0, id >>> 0) ?? null;
                if (text === null || (buffer >>> 0) === 0 || (size | 0) <= 0)
                {
                    if ((buffer >>> 0) !== 0 && (size | 0) > 0)
                    {
                        host.writeMemory(buffer, new Uint8Array(1));
                    }
                    return 0;
                }
                // The count includes the terminator, so the string itself gets
                // one fewer -- a caller sizing a buffer from the return value
                // and then reading it back would otherwise lose its last
                // character every time.
                const kept = text.slice(0, (size | 0) - 1);
                const bytes = new Uint8Array(kept.length + 1);
                for (let at = 0; at < kept.length; at++)
                {
                    bytes[at] = kept.charCodeAt(at) & 0xff;
                }
                host.writeMemory(buffer, bytes);
                return kept.length;
            },
        },

        /**
         * HANDLE LoadImageA(HINSTANCE hInst, LPCSTR name, UINT type, int cx,
         *                  int cy, UINT fuLoad)
         *
         * Not implemented, for the same reason: an image comes out of the
         * resource directory. Null is what a program checks for.
         */
        LoadImageA: {
            argBytes: 24,
            handler: ()=>0,
        },

        /** HCURSOR LoadCursorA(HINSTANCE hInstance, LPCSTR lpCursorName) */
        LoadCursorA: {
            argBytes: 8,
            /** @param {number[]} args */
            // A standard cursor is named by a small integer rather than by a
            // string, and those are the ones a program can expect to exist.
            handler: ([instance, name])=>((instance >>> 0) === 0
                && (name >>> 0) < 0x10000 ? name >>> 0 : 0),
        },

        /** HCURSOR SetCursor(HCURSOR hCursor) */
        SetCursor: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * int ShowCursor(BOOL bShow)
         *
         * A counter, not a flag: a program hides the cursor several times and
         * shows it as many, and reads the count to know where it stands.
         */
        ShowCursor: (()=>{
            let count = 0;
            return {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([show])=>{
                    count += (show >>> 0) !== 0 ? 1 : -1;
                    return count;
                },
            };
        })(),

        /** BOOL GetCursorPos(LPPOINT lpPoint) */
        GetCursorPos: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([point])=>{
                if ((point >>> 0) === 0)
                {
                    return 0;
                }
                const at = host.cursor?.() ?? { x: 0, y: 0 };
                writeU32s(host, point, [at.x, at.y]);
                return 1;
            },
        },

        /** BOOL SetCursorPos(int X, int Y) */
        SetCursorPos: {
            argBytes: 8,
            handler: ()=>1,
        },

        /** BOOL ClipCursor(const RECT *lpRect) */
        ClipCursor: {
            argBytes: 4,
            handler: ()=>1,
        },

        /**
         * SHORT GetAsyncKeyState(int vKey) / SHORT GetKeyState(int nVirtKey)
         *
         * The high bit says the key is down; the low bit of GetKeyState says a
         * toggle is on. A program polls these instead of reading messages when
         * it wants the state now rather than in the order it changed, and a
         * game does both at once -- menus from messages, movement from these.
         *
         * A build with nothing feeding it answers that nothing is pressed,
         * which is the one safe wrong answer: a state invented here would have
         * a program act on a press that never happened.
         */
        GetAsyncKeyState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([key])=>host.keyState?.(key >>> 0) ?? 0,
        },

        /** SHORT GetKeyState(int nVirtKey) */
        GetKeyState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([key])=>host.keyState?.(key >>> 0) ?? 0,
        },

        /**
         * UINT MapVirtualKeyA(UINT uCode, UINT uMapType)
         *
         * Only the mapping a program actually needs without a layout: a virtual
         * key to the character it produces unshifted.
         */
        MapVirtualKeyA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([code, mapType])=>{
                const MAPVK_VK_TO_CHAR = 2;
                if ((mapType >>> 0) !== MAPVK_VK_TO_CHAR)
                {
                    return 0;
                }
                const key = code >>> 0;
                if (key >= 0x41 && key <= 0x5a)
                {
                    return key;
                }
                return key >= 0x30 && key <= 0x39 ? key : 0;
            },
        },

        /**
         * HWND SetCapture(HWND hWnd)
         *
         * The captured window lives beside ReleaseCapture rather than inside
         * this entry, because the two are a pair: a release that does not clear
         * what was set leaves a program believing it still has the mouse.
         */
        SetCapture: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const previous = captured;
                captured = hwnd >>> 0;
                return previous;
            },
        },

        /** HWND GetCapture(void) */
        GetCapture: {
            argBytes: 0,
            handler: ()=>captured,
        },

        /** BOOL ReleaseCapture(void) */
        ReleaseCapture: {
            argBytes: 0,
            handler: ()=>{
                captured = 0;
                return 1;
            },
        },

        /**
         * UINT_PTR SetTimer(HWND hWnd, UINT_PTR nIDEvent, UINT uElapse,
         *                  TIMERPROC lpTimerFunc)
         *
         * Not implemented: a timer that never fires is a program waiting for a
         * WM_TIMER that never arrives, and one that fires immediately is a
         * program running its timer handler at the speed of the loop. Neither is
         * defensible, so this reports that the timer could not be created and
         * lets the program find out at the point it asked.
         */
        SetTimer: {
            argBytes: 16,
            handler: ()=>0,
        },

        /** BOOL KillTimer(HWND hWnd, UINT_PTR uIDEvent) */
        KillTimer: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * LRESULT SendMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam)
         *
         * Sending means running the window procedure before this returns, which
         * is the bridge's business. The dispatch service the bookkeeping half
         * already holds is exactly that, so this is the one place a message does
         * not go through the queue.
         */
        SendMessageA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hwnd, message, wParam, lParam])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                return host.dispatch(record.wndProc, {
                    hwnd: record.hwnd,
                    message: message >>> 0,
                    wParam: wParam >>> 0,
                    lParam: lParam >>> 0,
                });
            },
        },

        /** BOOL IsWindowVisible(HWND hWnd) */
        IsWindowVisible: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const WS_VISIBLE = 0x10000000;
                const record = live(hwnd);
                return record && (record.style & WS_VISIBLE) !== 0 ? 1 : 0;
            },
        },

        /** HWND GetActiveWindow(void) */
        GetActiveWindow: {
            argBytes: 0,
            handler: ()=>host.focus?.() ?? 0,
        },

        /** HWND GetForegroundWindow(void) */
        GetForegroundWindow: {
            argBytes: 0,
            handler: ()=>host.focus?.() ?? 0,
        },

        /** HWND GetFocus(void) */
        GetFocus: {
            argBytes: 0,
            handler: ()=>host.focus?.() ?? 0,
        },

        /**
         * DWORD GetClassLongA(HWND hWnd, int nIndex)
         *
         * Class data, not window data: every window of a class reads and writes
         * the same values, which is the whole reason a program reaches for this
         * instead of GetWindowLong.
         */
        GetClassLongA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, index])=>{
                const cls = classOfWindow(hwnd);
                return cls ? readClassLong(cls, index) : 0;
            },
        },

        /** DWORD SetClassLongA(HWND hWnd, int nIndex, LONG dwNewLong) */
        SetClassLongA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, index, value])=>{
                const cls = classOfWindow(hwnd);
                if (!cls)
                {
                    return 0;
                }
                const previous = readClassLong(cls, index);
                writeClassLong(cls, index, value);
                return previous;
            },
        },

        /** int GetClassNameA(HWND hWnd, LPSTR lpClassName, int nMaxCount) */
        GetClassNameA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, out, maxCount])=>{
                const record = live(hwnd);
                const room = maxCount | 0;
                if (!record || (out >>> 0) === 0 || room <= 0)
                {
                    return 0;
                }
                return writeString(out >>> 0, record.className, room);
            },
        },

        /**
         * BOOL EnableWindow(HWND hWnd, BOOL bEnable)
         *
         * The return is the state it *found*, and it is true when the window was
         * already disabled -- the opposite way round from what the argument
         * means, which is the classic way to read this backwards.
         */
        EnableWindow: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, enable])=>{
                const record = live(hwnd);
                if (!record)
                {
                    return 0;
                }
                const wasDisabled = (record.style & WS_DISABLED) !== 0;
                record.style = (enable >>> 0) !== 0
                    ? (record.style & ~WS_DISABLED) >>> 0
                    : (record.style | WS_DISABLED) >>> 0;
                return wasDisabled ? 1 : 0;
            },
        },

        /** HWND SetActiveWindow(HWND hWnd) */
        SetActiveWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const previous = host.focus?.() ?? 0;
                if (!live(hwnd))
                {
                    return 0;
                }
                host.setFocus?.(hwnd >>> 0);
                return previous;
            },
        },

        /** BOOL SetForegroundWindow(HWND hWnd) */
        SetForegroundWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                host.setFocus?.(hwnd >>> 0);
                return 1;
            },
        },

        /**
         * HWND FindWindowExA(HWND hWndParent, HWND hWndChildAfter,
         *                   LPCSTR lpszClass, LPCSTR lpszWindow)
         *
         * A null class or title matches anything, which is what makes this a
         * search rather than a lookup -- and hWndChildAfter is what lets a
         * caller walk every match instead of finding the first one for ever.
         */
        FindWindowExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, after, className, windowName])=>{
                const wanted = (className >>> 0) === 0
                    ? null
                    : host.readCString(className >>> 0, MAX_NAME);
                const title = (windowName >>> 0) === 0
                    ? null
                    : host.readCString(windowName >>> 0, MAX_NAME);
                const siblings = ordered().filter(record=>record.parent === (parent >>> 0));
                const start = (after >>> 0) === 0
                    ? 0
                    : siblings.findIndex(record=>record.hwnd === (after >>> 0)) + 1;
                for (let index = Math.max(start, 0); index < siblings.length; index++)
                {
                    const record = siblings[index];
                    if ((wanted === null || record.className === wanted)
                        && (title === null || record.title === title))
                    {
                        return record.hwnd;
                    }
                }
                return 0;
            },
        },

        /**
         * HWND GetTopWindow(HWND hWnd)
         *
         * A null window asks about the desktop's children, which are the
         * top-level windows -- the same thing GetWindow's GW_CHILD would answer
         * for a window that has no parent.
         */
        GetTopWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if ((hwnd >>> 0) !== 0 && !live(hwnd))
                {
                    return 0;
                }
                return ordered().find(record=>record.parent === (hwnd >>> 0))?.hwnd ?? 0;
            },
        },

        /**
         * int GetWindowTextLengthA(HWND hWnd)
         *
         * Without the terminator, unlike the buffer size GetWindowTextA takes --
         * a caller allocates this plus one, and a length that included the
         * terminator would have it allocate one too many for ever.
         */
        GetWindowTextLengthA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>live(hwnd)?.title.length ?? 0,
        },

        /**
         * DWORD GetWindowThreadProcessId(HWND hWnd, LPDWORD lpdwProcessId)
         *
         * The process reported has to be the one GetCurrentProcessId reports,
         * or a program comparing the two decides its own window belongs to
         * somebody else. Which thread created a window is not recorded, so the
         * thread identifier is the one that is asking.
         */
        GetWindowThreadProcessId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, out])=>{
                if (!live(hwnd))
                {
                    return 0;
                }
                if ((out >>> 0) !== 0)
                {
                    writeU32s(host, out >>> 0, [host.processId ?? 0x1000]);
                }
                return host.currentThread?.().id >>> 0 || 1;
            },
        },

        /**
         * BOOL IntersectRect(LPRECT lprcDst, const RECT *lprcSrc1,
         *                   const RECT *lprcSrc2)
         *
         * An empty intersection writes an empty rectangle as well as answering
         * FALSE: a caller that ignores the return and reads the destination
         * must not find one of the sources still in it.
         */
        IntersectRect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, first, second])=>{
                if ((out >>> 0) === 0 || (first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return 0;
                }
                const a = readRect(host, first >>> 0);
                const b = readRect(host, second >>> 0);
                const meet = {
                    left: Math.max(a.left, b.left),
                    top: Math.max(a.top, b.top),
                    right: Math.min(a.right, b.right),
                    bottom: Math.min(a.bottom, b.bottom),
                };
                const empty = meet.right <= meet.left || meet.bottom <= meet.top;
                writeRect(host, out >>> 0,
                    empty ? { left: 0, top: 0, right: 0, bottom: 0 } : meet);
                return empty ? 0 : 1;
            },
        },

        /**
         * LRESULT CallWindowProcA(WNDPROC lpPrevWndFunc, HWND hWnd, UINT Msg,
         *                        WPARAM wParam, LPARAM lParam)
         *
         * Subclassing: a program has replaced a window procedure and calls the
         * one it replaced through this. It goes through the same dispatch every
         * other call into guest code goes through, so the bridge suspends this
         * call until the procedure returns.
         */
        CallWindowProcA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([previous, hwnd, message, wParam, lParam])=>{
                if ((previous >>> 0) === 0)
                {
                    return 0;
                }
                return host.dispatch(previous >>> 0, {
                    hwnd: hwnd >>> 0,
                    message: message >>> 0,
                    wParam: wParam >>> 0,
                    lParam: lParam >>> 0,
                });
            },
        },

        /** HWND SetFocus(HWND hWnd) */
        SetFocus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                const previous = host.focus?.() ?? 0;
                if ((hwnd >>> 0) !== 0 && !live(hwnd))
                {
                    return 0;
                }
                host.setFocus?.(hwnd >>> 0);
                return previous;
            },
        },
    };
}
