/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { after } from '../user32/controls.js';

/**
 * uxtheme — the visual-styles engine, on a desktop drawn in the classic style.
 *
 * A program asks whether themes are on before it picks how to draw a control,
 * and a framework binds the whole library by name before it asks anything, so
 * every documented entry point Windows XP SP3 has is here and none that came
 * later: GetProcAddress answering NULL for one of those is how the caller
 * learns it is on XP. With no visual style active every question has the classic answer.
 * No theme data opens, so every call about a theme handle is given one this
 * library never made and refuses it as E_HANDLE; the system-metric calls,
 * which are documented to answer the global value when given no theme, ask
 * user32 for it, so a program reading the system through either library is
 * told the same thing.
 */

const S_OK = 0;
/** E_HANDLE: the theme handle is not one OpenThemeData answered. */
const E_HANDLE = 0x80070006;
/** E_POINTER: a pointer the call cannot do without was NULL. */
const E_POINTER = 0x80004003;
/** E_INVALIDARG: the identifier names no value of the kind asked for. */
const E_INVALIDARG = 0x80070057;
/** E_OUTOFMEMORY: no scratch memory for the system's answer. */
const E_OUTOFMEMORY = 0x8007000e;
/** E_FAIL: user32 did not answer the system value asked for. */
const E_FAIL = 0x80004005;
/** E_PROP_ID_UNSUPPORTED: what a question about the current theme meets with none loaded. */
const E_PROP_ID_UNSUPPORTED = 0x80070490;
/** HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND): no visual-style file is there to be read. */
const E_FILE_NOT_FOUND = 0x80070002;

/** SetThemeAppProperties' flags: what a process lets visual styles touch. */
const STAP_ALLOW_NONCLIENT = 0x1;
const STAP_ALLOW_CONTROLS = 0x2;
const STAP_ALLOW_WEBCONTENT = 0x4;

/** GetThemeSysFont's identifiers, and GetThemeSysBool's one. */
const TMT_CAPTIONFONT = 801;
const TMT_SMALLCAPTIONFONT = 802;
const TMT_MENUFONT = 803;
const TMT_STATUSFONT = 804;
const TMT_MSGBOXFONT = 805;
const TMT_ICONTITLEFONT = 806;
const TMT_FLATMENUS = 1001;

const SPI_GETICONTITLELOGFONT = 0x001f;
const SPI_GETNONCLIENTMETRICS = 0x0029;
const SPI_GETFLATMENU = 0x1022;

/** LOGFONTW, and NONCLIENTMETRICSW as XP lays it out: no iPaddedBorderWidth on the end. */
const LOGFONTW_SIZE = 92;
const NONCLIENTMETRICSW_SIZE = 500;

/**
 * Where each system font sits in NONCLIENTMETRICSW: the caption font after
 * cbSize and the five frame sizes, the small caption and menu fonts each after
 * a pair of sizes of their own, and the status and message fonts straight
 * after the menu's. The icon title font is not among them and has a query of
 * its own.
 */
const NONCLIENT_FONTS = new Map([
    [TMT_CAPTIONFONT, 24],
    [TMT_SMALLCAPTIONFONT, 24 + LOGFONTW_SIZE + 8],
    [TMT_MENUFONT, 24 + 2 * (LOGFONTW_SIZE + 8)],
    [TMT_STATUSFONT, 24 + 2 * (LOGFONTW_SIZE + 8) + LOGFONTW_SIZE],
    [TMT_MSGBOXFONT, 24 + 2 * (LOGFONTW_SIZE + 8) + 2 * LOGFONTW_SIZE],
]);

const WM_ERASEBKGND = 0x0014;
const WM_THEMECHANGED = 0x031a;
const WM_PRINTCLIENT = 0x0318;
const PRF_CLIENT = 0x4;
const GA_PARENT = 1;

/**
 * @typedef {{ handler: (args: number[]) => any }} Export
 *
 * @typedef {Object} ThemeHost
 * @property {(code: number) => void} [setLastError]
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a structure user32 fills, freed with `release`.
 * @property {(address: number) => void} [release]
 * @property {(name: string) => Export | undefined} [user32]
 *           user32's export of that name, looked up when called.
 * @property {(name: string) => Export | undefined} [gdi32]
 */

/**
 * @param {ThemeHost} host
 */
export function createThemeFunctions(host){
    /**
     * What a process has said visual styles may touch. The answer is kept
     * even with none active, since it is the process's own setting and
     * outlives whichever style the user picks.
     */
    let appProperties = STAP_ALLOW_NONCLIENT | STAP_ALLOW_CONTROLS | STAP_ALLOW_WEBCONTENT;

    /** @param {string} name @param {number[]} args @returns {any} */
    const user32 = (name, args)=>host.user32?.(name)?.handler(args) ?? 0;
    /** @param {string} name @param {number[]} args @returns {any} */
    const gdi32 = (name, args)=>host.gdi32?.(name)?.handler(args) ?? 0;

    /** Every call about a theme handle: whatever it was given, this library never made it. */
    const noTheme = ()=>E_HANDLE;

    /**
     * The calls that answer a value rather than an HRESULT say why there is
     * none the only way they can: in the last error.
     */
    const noThemeValue = ()=>{
        host.setLastError?.(E_HANDLE);
        return 0;
    };

    /**
     * Whether a handle names a window. Without user32 to ask, any handle but
     * NULL is taken for one.
     *
     * @param {number} hwnd
     */
    const isWindow = hwnd=>(hwnd >>> 0) !== 0
        && (host.user32?.('IsWindow') === undefined || user32('IsWindow', [hwnd >>> 0]) !== 0);

    /**
     * Runs `use` over guest memory user32 can write into, freed after;
     * null when there is no memory to be had.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => T} use @returns {T | null}
     */
    const withScratch = (bytes, use)=>{
        const at = host.allocate?.(bytes) ?? 0;
        if (at === 0 || !host.readMemory || !host.writeMemory)
        {
            if (at !== 0)
            {
                host.release?.(at);
            }
            return null;
        }
        try
        {
            return use(at);
        }
        finally
        {
            host.release?.(at);
        }
    };

    /** @param {number} at @param {number} count @returns {number[]} signed */
    const readInts = (at, count)=>{
        const bytes = /** @type {NonNullable<ThemeHost['readMemory']>} */ (host.readMemory)(
            at >>> 0, count * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: count }, (_, index)=>view.getInt32(index * 4, true));
    };

    /**
     * GetThemeSysFont with no theme: the font the system draws that part of
     * the screen in, as SystemParametersInfo reports it.
     *
     * @param {number} fontId @param {number} out
     */
    const systemFont = (fontId, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        if ((fontId | 0) === TMT_ICONTITLEFONT)
        {
            return user32('SystemParametersInfoW',
                [SPI_GETICONTITLELOGFONT, LOGFONTW_SIZE, out >>> 0, 0]) !== 0 ? S_OK : E_FAIL;
        }
        const offset = NONCLIENT_FONTS.get(fontId | 0);
        if (offset === undefined)
        {
            return E_INVALIDARG;
        }
        return withScratch(NONCLIENTMETRICSW_SIZE, at=>{
            const metrics = /** @type {NonNullable<ThemeHost['readMemory']>} */ (host.readMemory);
            const write = /** @type {NonNullable<ThemeHost['writeMemory']>} */ (host.writeMemory);
            write(at, new Uint8Array(new Uint32Array([NONCLIENTMETRICSW_SIZE]).buffer));
            if (user32('SystemParametersInfoW',
                [SPI_GETNONCLIENTMETRICS, NONCLIENTMETRICSW_SIZE, at, 0]) === 0)
            {
                return E_FAIL;
            }
            write(out >>> 0, metrics(at + offset, LOGFONTW_SIZE).slice());
            return S_OK;
        }) ?? E_OUTOFMEMORY;
    };

    /**
     * GetThemeSysBool with no theme: the system's own setting, for the one
     * boolean a theme carries. A setting user32 does not answer is off.
     *
     * @param {number} boolId
     */
    const systemBool = boolId=>{
        if ((boolId | 0) !== TMT_FLATMENUS)
        {
            return 0;
        }
        return withScratch(4, at=>(
            user32('SystemParametersInfoW', [SPI_GETFLATMENU, 0, at, 0]) !== 0
                && readInts(at, 1)[0] !== 0 ? 1 : 0)) ?? 0;
    };

    /**
     * DrawThemeParentBackground: the parent paints its own client area,
     * erased and then printed, into the child's DC, shifted so the part
     * behind the child lands where the child is and clipped to the area
     * asked for. The child's DC comes back as it went in -- the parent's
     * handlers are free to change it, and the child goes on painting in it.
     * A window that is not a child has no parent behind it to ask.
     *
     * @param {number} hwnd @param {number} hdc @param {number} rect
     */
    const paintParent = (hwnd, hdc, rect)=>{
        if (!isWindow(hwnd))
        {
            return E_HANDLE;
        }
        const parent = user32('GetAncestor', [hwnd >>> 0, GA_PARENT]) >>> 0;
        if (parent === 0 || parent === user32('GetDesktopWindow', []) >>> 0)
        {
            return S_OK;
        }
        const placed = withScratch(16, at=>{
            /** @type {NonNullable<ThemeHost['writeMemory']>} */ (host.writeMemory)(
                at, new Uint8Array(16));
            user32('MapWindowPoints', [hwnd >>> 0, parent, at, 1]);
            const [x, y] = readInts(at, 2);
            if ((rect >>> 0) === 0)
            {
                user32('GetClientRect', [hwnd >>> 0, at]);
            }
            const [left, top, right, bottom] = readInts((rect >>> 0) || at, 4);
            return { x, y, area: [left, top, right, bottom] };
        });
        if (placed === null)
        {
            return E_OUTOFMEMORY;
        }
        const saved = gdi32('SaveDC', [hdc >>> 0]);
        gdi32('IntersectClipRect', [hdc >>> 0, ...placed.area]);
        gdi32('OffsetViewportOrgEx', [hdc >>> 0, -placed.x, -placed.y, 0]);
        const restore = ()=>{
            if (saved !== 0)
            {
                gdi32('RestoreDC', [hdc >>> 0, saved]);
            }
        };
        /** @param {number} message @param {number} lParam */
        const send = (message, lParam)=>
            user32('SendMessageW', [parent, message, hdc >>> 0, lParam]);
        /** @type {any} */
        let painted;
        try
        {
            painted = after(send(WM_ERASEBKGND, 0), ()=>send(WM_PRINTCLIENT, PRF_CLIENT));
        }
        catch (e){
            restore();
            throw e;
        }
        if (typeof painted?.then !== 'function')
        {
            restore();
            return S_OK;
        }
        // A parent the program answers for answers later; the DC is put back
        // either way, a fault in its procedure included.
        return Promise.resolve(painted).finally(restore).then(()=>S_OK);
    };

    return {
        /** BOOL IsThemeActive(void) */
        IsThemeActive: {
            argBytes: 0,
            handler: ()=>0,
        },

        /** BOOL IsAppThemed(void) */
        IsAppThemed: {
            argBytes: 0,
            handler: ()=>0,
        },

        /**
         * HTHEME OpenThemeData(HWND hwnd, LPCWSTR pszClassList)
         *
         * No theme data to open, whatever the class: the last error says
         * there is no theme, or that there was no class list to look up.
         */
        OpenThemeData: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, classList])=>{
                host.setLastError?.((classList >>> 0) === 0 ? E_POINTER : E_PROP_ID_UNSUPPORTED);
                return 0;
            },
        },

        /** HRESULT CloseThemeData(HTHEME hTheme): no handle was ever given out. */
        CloseThemeData: {
            argBytes: 4,
            handler: noTheme,
        },

        /**
         * HRESULT DrawThemeBackground(HTHEME, HDC, int iPartId, int iStateId,
         *                             LPCRECT pRect, LPCRECT pClipRect)
         */
        DrawThemeBackground: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT DrawThemeEdge(HTHEME, HDC, int iPartId, int iStateId, LPCRECT pDestRect,
         *                       UINT uEdge, UINT uFlags, LPRECT pContentRect)
         */
        DrawThemeEdge: {
            argBytes: 32,
            handler: noTheme,
        },

        /**
         * HRESULT DrawThemeIcon(HTHEME, HDC, int iPartId, int iStateId, LPCRECT pRect,
         *                       HIMAGELIST himl, int iImageIndex)
         */
        DrawThemeIcon: {
            argBytes: 28,
            handler: noTheme,
        },

        /**
         * HRESULT DrawThemeText(HTHEME, HDC, int iPartId, int iStateId, LPCWSTR pszText,
         *                       int iCharCount, DWORD dwTextFlags, DWORD dwTextFlags2,
         *                       LPCRECT pRect)
         */
        DrawThemeText: {
            argBytes: 36,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeBackgroundContentRect(HTHEME, HDC, int iPartId, int iStateId,
         *                                       LPCRECT pBoundingRect, LPRECT pContentRect)
         */
        GetThemeBackgroundContentRect: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeBackgroundExtent(HTHEME, HDC, int iPartId, int iStateId,
         *                                  LPCRECT pContentRect, LPRECT pExtentRect)
         */
        GetThemeBackgroundExtent: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeBackgroundRegion(HTHEME, HDC, int iPartId, int iStateId,
         *                                  LPCRECT pRect, HRGN *pRegion)
         */
        GetThemeBackgroundRegion: {
            argBytes: 24,
            handler: noTheme,
        },

        /** HRESULT GetThemeBool(HTHEME, int iPartId, int iStateId, int iPropId, BOOL *pfVal) */
        GetThemeBool: {
            argBytes: 20,
            handler: noTheme,
        },

        /** HRESULT GetThemeColor(HTHEME, int iPartId, int iStateId, int iPropId, COLORREF *pColor) */
        GetThemeColor: {
            argBytes: 20,
            handler: noTheme,
        },

        /** HRESULT GetThemeEnumValue(HTHEME, int iPartId, int iStateId, int iPropId, int *piVal) */
        GetThemeEnumValue: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeFilename(HTHEME, int iPartId, int iStateId, int iPropId,
         *                          LPWSTR pszThemeFilename, int cchMaxBuffChars)
         */
        GetThemeFilename: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeFont(HTHEME, HDC, int iPartId, int iStateId, int iPropId,
         *                      LOGFONTW *pFont)
         */
        GetThemeFont: {
            argBytes: 24,
            handler: noTheme,
        },

        /** HRESULT GetThemeInt(HTHEME, int iPartId, int iStateId, int iPropId, int *piVal) */
        GetThemeInt: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeIntList(HTHEME, int iPartId, int iStateId, int iPropId,
         *                         INTLIST *pIntList)
         */
        GetThemeIntList: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeMargins(HTHEME, HDC, int iPartId, int iStateId, int iPropId,
         *                         LPCRECT prc, MARGINS *pMargins)
         */
        GetThemeMargins: {
            argBytes: 28,
            handler: noTheme,
        },

        /** HRESULT GetThemeMetric(HTHEME, HDC, int iPartId, int iStateId, int iPropId, int *piVal) */
        GetThemeMetric: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemePartSize(HTHEME, HDC, int iPartId, int iStateId, LPCRECT prc,
         *                          THEMESIZE eSize, SIZE *psz)
         */
        GetThemePartSize: {
            argBytes: 28,
            handler: noTheme,
        },

        /** HRESULT GetThemePosition(HTHEME, int iPartId, int iStateId, int iPropId, POINT *pPoint) */
        GetThemePosition: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemePropertyOrigin(HTHEME, int iPartId, int iStateId, int iPropId,
         *                                PROPERTYORIGIN *pOrigin)
         */
        GetThemePropertyOrigin: {
            argBytes: 20,
            handler: noTheme,
        },

        /** HRESULT GetThemeRect(HTHEME, int iPartId, int iStateId, int iPropId, LPRECT pRect) */
        GetThemeRect: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeString(HTHEME, int iPartId, int iStateId, int iPropId,
         *                        LPWSTR pszBuff, int cchMaxBuffChars)
         */
        GetThemeString: {
            argBytes: 24,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeTextExtent(HTHEME, HDC, int iPartId, int iStateId, LPCWSTR pszText,
         *                            int iCharCount, DWORD dwTextFlags,
         *                            LPCRECT pBoundingRect, LPRECT pExtentRect)
         */
        GetThemeTextExtent: {
            argBytes: 36,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeTextMetrics(HTHEME, HDC, int iPartId, int iStateId,
         *                             TEXTMETRICW *ptm)
         */
        GetThemeTextMetrics: {
            argBytes: 20,
            handler: noTheme,
        },

        /**
         * HRESULT HitTestThemeBackground(HTHEME, HDC, int iPartId, int iStateId,
         *                                DWORD dwOptions, LPCRECT pRect, HRGN hrgn,
         *                                POINT ptTest, WORD *pwHitTestCode)
         *
         * The point comes by value, two words of the stack.
         */
        HitTestThemeBackground: {
            argBytes: 40,
            handler: noTheme,
        },

        /** BOOL IsThemeBackgroundPartiallyTransparent(HTHEME, int iPartId, int iStateId) */
        IsThemeBackgroundPartiallyTransparent: {
            argBytes: 12,
            handler: noThemeValue,
        },

        /** BOOL IsThemePartDefined(HTHEME, int iPartId, int iStateId) */
        IsThemePartDefined: {
            argBytes: 12,
            handler: noThemeValue,
        },

        /**
         * COLORREF GetThemeSysColor(HTHEME hTheme, int iColorId)
         *
         * With no theme, the global system colour.
         */
        GetThemeSysColor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([theme, colorId])=>((theme >>> 0) === 0
                ? user32('GetSysColor', [colorId]) : noThemeValue()),
        },

        /**
         * HBRUSH GetThemeSysColorBrush(HTHEME hTheme, int iColorId)
         *
         * With no theme, the system's own brush for the colour, which the
         * caller must not delete.
         */
        GetThemeSysColorBrush: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([theme, colorId])=>((theme >>> 0) === 0
                ? user32('GetSysColorBrush', [colorId]) : noThemeValue()),
        },

        /**
         * int GetThemeSysSize(HTHEME hTheme, int iSizeId)
         *
         * With no theme, the identifier is GetSystemMetrics' own index.
         */
        GetThemeSysSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([theme, sizeId])=>((theme >>> 0) === 0
                ? user32('GetSystemMetrics', [sizeId]) : noThemeValue()),
        },

        /** BOOL GetThemeSysBool(HTHEME hTheme, int iBoolId) */
        GetThemeSysBool: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([theme, boolId])=>((theme >>> 0) === 0
                ? systemBool(boolId) : noThemeValue()),
        },

        /** HRESULT GetThemeSysFont(HTHEME hTheme, int iFontId, LOGFONTW *plf) */
        GetThemeSysFont: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([theme, fontId, out])=>((theme >>> 0) === 0
                ? systemFont(fontId, out) : E_HANDLE),
        },

        /**
         * HRESULT GetThemeSysInt(HTHEME hTheme, int iIntId, int *piValue)
         *
         * A theme's own value -- its minimum colour depth -- that the system
         * has no counterpart of: the handle is required.
         */
        GetThemeSysInt: {
            argBytes: 12,
            handler: noTheme,
        },

        /**
         * HRESULT GetThemeSysString(HTHEME hTheme, int iStringId, LPWSTR pszStringBuff,
         *                           int cchMaxStringChars)
         *
         * The theme's style sheet names: the handle is required.
         */
        GetThemeSysString: {
            argBytes: 16,
            handler: noTheme,
        },

        /**
         * HRESULT GetCurrentThemeName(LPWSTR pszThemeFileName, int cchMaxNameChars,
         *                             LPWSTR pszColorBuff, int cchMaxColorChars,
         *                             LPWSTR pszSizeBuff, int cchMaxSizeChars)
         *
         * There is no current theme to name; the buffers are left as they were.
         */
        GetCurrentThemeName: {
            argBytes: 24,
            handler: ()=>E_PROP_ID_UNSUPPORTED,
        },

        /**
         * HRESULT GetThemeDocumentationProperty(LPCWSTR pszThemeName,
         *                                       LPCWSTR pszPropertyName,
         *                                       LPWSTR pszValueBuff, int cchMaxValChars)
         *
         * Asked of a style file rather than the current theme, and none is
         * installed for it to be read from.
         */
        GetThemeDocumentationProperty: {
            argBytes: 16,
            handler: ()=>E_FILE_NOT_FOUND,
        },

        /**
         * HRESULT DrawThemeParentBackground(HWND hwnd, HDC hdc, const RECT *prc)
         *
         * About a window rather than a theme, so it works with none active.
         */
        DrawThemeParentBackground: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd, hdc, rect])=>paintParent(hwnd, hdc, rect),
        },

        /**
         * HTHEME GetWindowTheme(HWND hwnd)
         *
         * No window has theme data. A handle that is not a window is the
         * one case the last error is set for.
         */
        GetWindowTheme: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if (!isWindow(hwnd))
                {
                    host.setLastError?.(E_HANDLE);
                }
                return 0;
            },
        },

        /**
         * HRESULT SetWindowTheme(HWND hwnd, LPCWSTR pszSubAppName, LPCWSTR pszSubIdList)
         *
         * The window is sent WM_THEMECHANGED, itself and not its children,
         * so that it looks its theme up again -- and finds none, as before.
         */
        SetWindowTheme: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hwnd])=>{
                if (!isWindow(hwnd))
                {
                    return E_HANDLE;
                }
                return after(user32('SendMessageW', [hwnd >>> 0, WM_THEMECHANGED, 0, 0]),
                    ()=>S_OK);
            },
        },

        /**
         * HRESULT EnableThemeDialogTexture(HWND hwnd, DWORD dwFlags)
         *
         * A dialog background drawn from a theme, of which there is none:
         * the dialog keeps the colour the classic style erases it with.
         */
        EnableThemeDialogTexture: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd])=>(isWindow(hwnd) ? S_OK : E_HANDLE),
        },

        /** BOOL IsThemeDialogTextureEnabled(HWND hwnd): there is no texture to draw. */
        IsThemeDialogTextureEnabled: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * HRESULT EnableTheming(BOOL fEnable)
         *
         * Turning theming off leaves it off; turning it on brings back the
         * theme the user last had active, and this user had none.
         */
        EnableTheming: {
            argBytes: 4,
            handler: ()=>S_OK,
        },

        /** DWORD GetThemeAppProperties(void) */
        GetThemeAppProperties: {
            argBytes: 0,
            handler: ()=>appProperties,
        },

        /** void SetThemeAppProperties(DWORD dwFlags) */
        SetThemeAppProperties: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flags])=>{
                appProperties = flags >>> 0;
                return 0;
            },
        },
    };
}
