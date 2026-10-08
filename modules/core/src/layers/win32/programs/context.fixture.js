/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A system program's context for the tests of its routine: every call it
 * makes is recorded, a string it placed in the guest reads back as `L"text"`
 * for UTF-16 and `"text"` for ANSI, and each call answers what the test says.
 */

/**
 * @typedef {{ library?: string, name?: string, guest?: number, args?: any[],
 *     message?: string, caption?: string, type?: number }} Recorded
 */

/**
 * @param {string} commandLine  argv[0] and all.
 * @param {(call: Recorded) => number | undefined} [answer]  0 when it says nothing.
 */
export function fakeContext(commandLine, answer = ()=>0){
    /** @type {Map<number, string>} */
    const strings = new Map();
    /** @type {Recorded[]} */
    const calls = [];
    let next = 0x10000;
    /** @param {string} shown */
    const place = shown=>{
        const at = next;
        next += 0x100;
        strings.set(at, shown);
        return at;
    };
    /** @param {number[]} args */
    const shown = args=>args.map(arg=>strings.get(arg) ?? arg);
    /** @param {Recorded} call */
    const answered = call=>{
        calls.push(call);
        return answer(call) ?? 0;
    };
    /** @type {import('./msiexec.js').ProgramContext} */
    const context = {
        commandLine,
        call: async(library, name, args)=>answered({ library, name, args: shown(args) }),
        callGuest: async(entry, args)=>answered({ guest: entry, args: shown(args) }),
        wide: text=>place(`L"${text}"`),
        ansi: text=>place(`"${text}"`),
        message: async(message, caption, type)=>answered({ message, caption, type }),
    };
    return { context, calls };
}
