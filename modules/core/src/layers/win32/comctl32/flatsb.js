/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Flat scroll bars: a window's scroll bars drawn flat, which comctl32 offers
 * once InitializeFlatSB is called for the window, and otherwise -- as here,
 * where there is no flat look to draw -- each call is the standard scroll
 * bar's: "If flat scroll bars haven't been initialized for the window, the
 * flat scroll bar APIs will defer to the corresponding standard APIs." A
 * framework's scrolling control makes these calls for every window it
 * creates. Wine's comctl32 answers the same: InitializeFlatSB succeeds, the
 * flat-only properties are neither kept nor reported, and the rest is user32.
 */

/** @typedef {(name: string) => ({ handler: (args: number[]) => any } | undefined)} User32 */

/**
 * @param {{ user32?: User32 }} host
 */
export function createFlatScrollBarFunctions(host){
    /**
     * The standard call a flat one defers to, its arguments as they came; a
     * build without user32 behind it answers the failure the call has.
     *
     * @param {string} name @param {number} argBytes
     */
    const deferred = (name, argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>host.user32?.(name)?.handler(args) ?? 0,
    });
    return {
        /** BOOL InitializeFlatSB(HWND hwnd) */
        InitializeFlatSB: { argBytes: 4, handler: ()=>1 },
        /** HRESULT UninitializeFlatSB(HWND hwnd): S_FALSE, there being nothing to undo. */
        UninitializeFlatSB: { argBytes: 4, handler: ()=>1 },
        /** BOOL FlatSB_GetScrollProp(HWND hwnd, INT index, LPINT pValue) */
        FlatSB_GetScrollProp: { argBytes: 12, handler: ()=>0 },
        /** BOOL FlatSB_SetScrollProp(HWND hwnd, UINT index, INT_PTR newValue, BOOL fRedraw) */
        FlatSB_SetScrollProp: { argBytes: 16, handler: ()=>0 },
        /** BOOL FlatSB_EnableScrollBar(HWND hwnd, int wSBflags, UINT wArrows) */
        FlatSB_EnableScrollBar: deferred('EnableScrollBar', 12),
        /** BOOL FlatSB_ShowScrollBar(HWND hwnd, int code, BOOL fShow) */
        FlatSB_ShowScrollBar: deferred('ShowScrollBar', 12),
        /** BOOL FlatSB_GetScrollRange(HWND hwnd, int code, LPINT lpMinPos, LPINT lpMaxPos) */
        FlatSB_GetScrollRange: deferred('GetScrollRange', 16),
        /** BOOL FlatSB_GetScrollInfo(HWND hwnd, int code, LPSCROLLINFO lpsi) */
        FlatSB_GetScrollInfo: deferred('GetScrollInfo', 12),
        /** int FlatSB_GetScrollPos(HWND hwnd, int code) */
        FlatSB_GetScrollPos: deferred('GetScrollPos', 8),
        /** int FlatSB_SetScrollPos(HWND hwnd, int code, int pos, BOOL fRedraw) */
        FlatSB_SetScrollPos: deferred('SetScrollPos', 16),
        /** int FlatSB_SetScrollInfo(HWND hwnd, int code, LPSCROLLINFO psi, BOOL fRedraw) */
        FlatSB_SetScrollInfo: deferred('SetScrollInfo', 16),
        /** int FlatSB_SetScrollRange(HWND hwnd, int code, int min, int max, BOOL fRedraw) */
        FlatSB_SetScrollRange: deferred('SetScrollRange', 20),
    };
}
