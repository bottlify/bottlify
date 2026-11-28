/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * What a program says about itself.
 *
 * On Windows these go to a debugger if one is attached and are dropped if none
 * is. Here something is always attached, because this is the most direct thing
 * a running program tells us about what it thinks is happening -- a trace, an
 * assertion, the message before it gives up. Dropping it would mean throwing
 * away the one channel the program itself chose to use.
 */

/**
 * @typedef {Object} DebugHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(text: string) => void} say  Where a program's own words go.
 * @property {(report: { code: number, string: { address: number, length: number,
 *     unicode: boolean } }) => Promise<number>} [report]  This process's debugger, when
 *     its parent debugs it: its words go there too, the thread waiting until heard.
 * @property {() => boolean} [debugged]  Whether a debugger hears this process now;
 *     absent, whenever `report` is given.
 * @property {() => boolean} [beingDebugged]  The process block's BeingDebugged, which
 *     IsDebuggerPresent reads.
 */

/** OUTPUT_DEBUG_STRING_EVENT (`debug-events.js`). */
const OUTPUT_DEBUG_STRING_EVENT = 8;

/** A trace longer than this is a program that lost its terminator. */
const MAX_TRACE = 1 << 16;

/**
 * @param {DebugHost} host
 */
export function createDebugFunctions(host){
    const { guest } = host;
    /**
     * A debuggee's words, told to its debugger as OUTPUT_DEBUG_STRING: the
     * string where it is, its length in characters with the terminator.
     *
     * @param {number} address @param {number} length @param {boolean} unicode
     * @returns {number | Promise<number>}
     */
    const tell = (address, length, unicode)=>(host.report && (host.debugged?.() ?? true)
        ? host.report({ code: OUTPUT_DEBUG_STRING_EVENT,
            string: { address, length, unicode } }).then(()=>0)
        : 0);

    return {
        /** VOID OutputDebugStringA(LPCSTR lpOutputString) */
        OutputDebugStringA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                if (wholeAddress(text) === 0)
                {
                    return 0;
                }
                const said = guest.cstr(wholeAddress(text), MAX_TRACE);
                host.say(said);
                return tell(wholeAddress(text), said.length + 1, false);
            },
        },

        /** VOID OutputDebugStringW(LPCWSTR lpOutputString) */
        OutputDebugStringW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                if (wholeAddress(text) === 0)
                {
                    return 0;
                }
                const said = guest.wstr(wholeAddress(text), MAX_TRACE * 2);
                host.say(said);
                return tell(wholeAddress(text), said.length + 1, true);
            },
        },

        /**
         * VOID DebugBreak()
         *
         * On Windows this raises a breakpoint for an attached debugger, and
         * terminates the process when none is attached. Nothing is attached
         * here, so what a program means by calling it is "stop now" -- but it is
         * reported rather than acted on, because it is nearly always reached
         * from an assertion whose message went through OutputDebugString a
         * moment earlier, and that pair is the most useful thing a failing
         * program tells us.
         */
        DebugBreak: {
            argBytes: 0,
            handler: ()=>{
                host.say('DebugBreak');
                return 0;
            },
        },

        /** BOOL IsDebuggerPresent() */
        IsDebuggerPresent: {
            argBytes: 0,
            // What the process block says, as on Windows: set when the
            // parent debugs this process, and the program may clear it. The
            // trace this file keeps is not a debugger a program should see.
            handler: ()=>(host.beingDebugged?.() ? 1 : 0),
        },
    };
}
