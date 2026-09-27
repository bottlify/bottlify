/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * uxtheme — the visual-styles engine, on a desktop drawn in the classic style.
 *
 * A program asks whether themes are on before it picks how to draw a control,
 * and user32 and comctl32 callers look the entry points up by name. With no
 * theme active every question has the classic answer: nothing is themed and
 * there is no theme data to open, so the caller draws the frame itself.
 */

/** E_HANDLE: the theme handle is not one OpenThemeData answered. */
const E_HANDLE = 0x80070006;
/** E_PROP_ID_UNSUPPORTED: the last error OpenThemeData leaves with no theme active. */
const E_PROP_ID_UNSUPPORTED = 0x80070490;

/**
 * @typedef {Object} ThemeHost
 * @property {(code: number) => void} [setLastError]
 */

/**
 * @param {ThemeHost} host
 */
export function createThemeFunctions(host){
    return {
        /** BOOL IsThemeActive(void) */
        IsThemeActive: { argBytes: 0, handler: ()=>0 },
        /** BOOL IsAppThemed(void) */
        IsAppThemed: { argBytes: 0, handler: ()=>0 },
        /** HTHEME OpenThemeData(HWND hwnd, LPCWSTR pszClassList) */
        OpenThemeData: {
            argBytes: 8,
            handler: ()=>{
                host.setLastError?.(E_PROP_ID_UNSUPPORTED);
                return 0;
            },
        },
        /** HRESULT CloseThemeData(HTHEME hTheme): no handle was ever given out. */
        CloseThemeData: { argBytes: 4, handler: ()=>E_HANDLE },
    };
}
