/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process's DPI awareness, and a thread's when it sets its own: what user32
 * (SetProcessDPIAware, the DPI_AWARENESS_CONTEXT functions of Windows 10) and
 * shcore (SetProcessDpiAwareness) set and read, one state for both as on
 * Windows. The one monitor is at 96 DPI, so awareness changes no pixel; it is
 * kept so a program reads back what it set.
 *
 * A context is passed in as a pseudo-handle (-1 unaware ... -5 unaware, GDI
 * scaled) and handed back as the value Windows hands back for it: the DPI in
 * bits 8 and up (0x60, 96) where it is fixed, the awareness in the low bits.
 * A program compares them through AreDpiAwarenessContextsEqual.
 */

const STANDARD_DPI = 96;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ACCESS_DENIED = 5;
/** DPI_AWARENESS_INVALID. */
const INVALID_AWARENESS = -1;

/**
 * The five contexts, by kind: the pseudo-handle a program passes, the value
 * Windows hands back, and its DPI_AWARENESS (unaware, system, per monitor).
 */
const KINDS = [
    { pseudo: -1, value: 0x6010, awareness: 0 },
    { pseudo: -2, value: 0x6011, awareness: 1 },
    { pseudo: -3, value: 0x12, awareness: 2 },
    { pseudo: -4, value: 0x22, awareness: 2 },
    { pseudo: -5, value: 0x40006010, awareness: 0 },
];
const UNAWARE = 0;
const SYSTEM_AWARE = 1;

/** @typedef {{ process: number | null, threads: Map<number, number> }} DpiState */

/** @returns {DpiState} A process's awareness, unset, and no thread's own. */
export function createDpiState(){
    return { process: null, threads: new Map() };
}

/** @param {number} context @returns {number} The context's kind, -1 for none. */
function kindOf(context){
    const signed = context | 0;
    return KINDS.findIndex(kind=>kind.pseudo === signed || kind.value === signed);
}

/**
 * shcore's PROCESS_DPI_AWARENESS set once a process: false when it was set.
 *
 * @param {DpiState} state @param {number} awareness  0, 1 or 2.
 */
export function setProcessAwareness(state, awareness){
    if (state.process !== null)
    {
        return false;
    }
    state.process = awareness;
    return true;
}

/** @param {DpiState} state @returns {number} The process's DPI_AWARENESS. */
export function processAwareness(state){
    return KINDS[state.process ?? UNAWARE].awareness;
}

/**
 * @param {DpiState} state
 * @param {{ setLastError: (code: number) => void, callerThread: () => number,
 *     isWindow: (hwnd: number) => boolean }} host
 */
export function createDpiFunctions(state, host){
    const processKind = ()=>state.process ?? UNAWARE;
    const threadKind = ()=>state.threads.get(host.callerThread()) ?? processKind();
    /** @param {number} context @returns {number} */
    const valid = context=>{
        const kind = kindOf(context);
        if (kind < 0)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
        }
        return kind;
    };
    return {
        /** BOOL SetProcessDPIAware(void): system aware, unless already set. */
        SetProcessDPIAware: {
            argBytes: 0,
            handler: ()=>{
                setProcessAwareness(state, SYSTEM_AWARE);
                return 1;
            },
        },
        IsProcessDPIAware: {
            argBytes: 0,
            handler: ()=>(KINDS[processKind()].awareness === UNAWARE ? 0 : 1),
        },

        /** BOOL SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT value) */
        SetProcessDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>{
                const kind = valid(context);
                if (kind < 0)
                {
                    return 0;
                }
                if (!setProcessAwareness(state, kind))
                {
                    host.setLastError(ERROR_ACCESS_DENIED);
                    return 0;
                }
                return 1;
            },
        },

        /** DPI_AWARENESS_CONTEXT GetThreadDpiAwarenessContext(void) */
        GetThreadDpiAwarenessContext: {
            argBytes: 0,
            handler: ()=>KINDS[threadKind()].value,
        },

        /** DPI_AWARENESS_CONTEXT SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT): the one before. */
        SetThreadDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>{
                const kind = valid(context);
                if (kind < 0)
                {
                    return 0;
                }
                const before = threadKind();
                state.threads.set(host.callerThread(), kind);
                return KINDS[before].value;
            },
        },

        /**
         * DPI_AWARENESS_CONTEXT GetWindowDpiAwarenessContext(HWND)
         *
         * ponytail: the process's context, not the creating thread's at
         * creation; a window per thread awareness is kept when one reads it.
         */
        GetWindowDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(host.isWindow(hwnd >>> 0) ? KINDS[processKind()].value : 0),
        },

        /** BOOL AreDpiAwarenessContextsEqual(DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT) */
        AreDpiAwarenessContextsEqual: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([a, b])=>{
                const kind = kindOf(a);
                return kind >= 0 && kind === kindOf(b) ? 1 : 0;
            },
        },

        /** BOOL IsValidDpiAwarenessContext(DPI_AWARENESS_CONTEXT) */
        IsValidDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>(kindOf(context) >= 0 ? 1 : 0),
        },

        /** DPI_AWARENESS GetAwarenessFromDpiAwarenessContext(DPI_AWARENESS_CONTEXT) */
        GetAwarenessFromDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>{
                const kind = kindOf(context);
                return kind < 0 ? INVALID_AWARENESS : KINDS[kind].awareness;
            },
        },

        /** UINT GetDpiFromDpiAwarenessContext(DPI_AWARENESS_CONTEXT): 96, 0 for none. */
        GetDpiFromDpiAwarenessContext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([context])=>(kindOf(context) >= 0 ? STANDARD_DPI : 0),
        },

        /** UINT GetDpiForSystem(void) */
        GetDpiForSystem: { argBytes: 0, handler: ()=>STANDARD_DPI },

        /** UINT GetDpiForWindow(HWND): 0 for a handle that is no window. */
        GetDpiForWindow: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hwnd])=>(host.isWindow(hwnd >>> 0) ? STANDARD_DPI : 0),
        },
    };
}
