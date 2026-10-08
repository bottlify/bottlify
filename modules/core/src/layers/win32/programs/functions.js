/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's own library, whose routines are the system programs
 * (`table.js`): each one the whole of a program, called by that program's
 * entry point on its main thread and answering its exit code.
 *
 * A routine works as the program would: it reads the process's command line
 * through GetCommandLineW, and everything it does after that is a call to an
 * export of this process -- LoadLibrary, GetProcAddress, msi.dll's
 * installation calls, MessageBox -- or into guest code the program was asked
 * to run, on the same thread. So what it does is what those exports do for
 * any program, and nothing here reaches past them.
 */

import { SYSTEM_PROGRAMS } from './table.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** The longest command line Windows hands a process, in characters. */
const MAX_COMMAND_LINE = 32768;

/**
 * @typedef {Object} ProgramsHost
 * @property {(library: string) => Record<string, any> | undefined} exports
 *     A library's table in this process, by the name it is kept under.
 * @property {() => any} callerThread  The thread whose call is being answered.
 * @property {(thread: any, fn: () => any) => any} answering
 *     Runs `fn` as that thread's call, after an await.
 * @property {(entry: number, args: number[], thread: any) => Promise<number>} callGuest
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 */

/** @param {string} text */
const wideBytes = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/**
 * @param {ProgramsHost} host
 * @returns {Record<string, { argBytes: number, handler: () => Promise<number> }>}
 */
export function createProgramFunctions(host){
    /**
     * @param {(context: import('./msiexec.js').ProgramContext) => Promise<number>} run
     */
    const program = run=>async()=>{
        // Named once, here: everything after the first await answers for it.
        const thread = host.callerThread();
        /** @type {number[]} */
        const held = [];
        /** @param {Uint8Array} bytes */
        const place = bytes=>{
            const at = host.allocate(bytes.length);
            host.writeMemory(at, bytes);
            held.push(at);
            return at;
        };
        /** @param {string} library @param {string} name @param {number[]} args */
        const call = async(library, name, args)=>{
            const entry = host.exports(library)?.[name];
            if (!entry)
            {
                throw new Error(`${library}!${name}, which a system program calls, is not here`);
            }
            return (await host.answering(thread, ()=>entry.handler(args))) >>> 0;
        };
        /** @param {string} text */
        const wide = text=>place(wideBytes(text));
        try
        {
            const commandLine = host.readWideString(
                await call('KERNEL32.dll', 'GetCommandLineW', []), MAX_COMMAND_LINE);
            return (await run({
                commandLine,
                call,
                callGuest: (entry, args)=>host.callGuest(entry, args, thread),
                wide,
                read: (at, length)=>host.readMemory?.(at, length).slice() ?? new Uint8Array(0),
                block: size=>place(new Uint8Array(size)),
                ansi: text=>place(encodeAnsi(`${text}\0`)),
                message: (text, caption, type)=>call('USER32.dll', 'MessageBoxW',
                    [0, wide(text), wide(caption), type]),
            })) >>> 0;
        }
        finally
        {
            held.forEach(at=>host.free(at));
        }
    };

    return Object.fromEntries([...SYSTEM_PROGRAMS.values()].map(({ routine, run })=>
        [routine, { argBytes: 0, handler: program(run) }]));
}
