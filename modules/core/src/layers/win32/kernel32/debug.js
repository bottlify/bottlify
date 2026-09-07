/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(text: string) => void} say  Where a program's own words go.
 */

/** A trace longer than this is a program that lost its terminator. */
const MAX_TRACE = 1 << 16;

/**
 * @param {DebugHost} host
 */
export function createDebugFunctions(host){
    return {
        /** VOID OutputDebugStringA(LPCSTR lpOutputString) */
        OutputDebugStringA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                host.say(host.readCString(text >>> 0, MAX_TRACE));
                return 0;
            },
        },

        /** VOID OutputDebugStringW(LPCWSTR lpOutputString) */
        OutputDebugStringW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([text])=>{
                host.say(host.readWideString(text >>> 0, MAX_TRACE));
                return 0;
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
            // Answering yes would be true in spirit and wrong in effect: a
            // program that believes a debugger is attached may break into it,
            // wait for it, or take a path meant for a developer's machine.
            handler: ()=>0,
        },
    };
}
