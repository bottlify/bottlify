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

import { PROGRAMS_IN_PLACE, SYSTEM_PROGRAMS } from './table.js';
import { runOnceAtLogon } from './runonce.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { utf16z } from '../common/utf16.js';

/** The routine the first process's start calls for the logon's RunOnce pass. */
export const RUN_ONCE_ROUTINE = 'runonce';

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
 * @property {(layer: string) => void} [need]  Asks the embedder for a layer the
 *     machine lacks (`layer-needed`).
 * @property {(thread: any) => Promise<number>} [serveCustomActions]  msi.dll's
 *     custom action server over this process's standard input and output.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {ProgramsHost} host
 * @returns {Record<string, { argBytes: number, handler: () => Promise<number> }>}
 */
export function createProgramFunctions(host){
    /**
     * Runs `body` as a program on the calling thread, its context over this
     * process's exports, what it places in the guest freed when it is done.
     * The context it is handed has the process's command line; `contextFor`
     * makes one with another, for a program the logon runs here.
     *
     * @param {(context: import('./msiexec.js').ProgramContext,
     *     contextFor: (commandLine: string) => import('./msiexec.js').ProgramContext)
     *     => Promise<number>} body
     */
    const asProgram = async body=>{
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
        const wide = text=>place(utf16z(text));
        /**
         * @param {string} commandLine
         * @returns {import('./msiexec.js').ProgramContext}
         */
        const contextFor = commandLine=>({
            commandLine,
            call,
            callGuest: (entry, args)=>host.callGuest(entry, args, thread),
            wide,
            read: (at, length)=>host.readMemory?.(at, length).slice() ?? new Uint8Array(0),
            write: (at, data)=>host.writeMemory(at, data),
            block: size=>place(new Uint8Array(size)),
            bytes: data=>place(data.slice()),
            ansi: text=>place(encodeAnsi(`${text}\0`)),
            message: (text, caption, type)=>call('USER32.dll', 'MessageBoxW',
                [0, wide(text), wide(caption), type]),
            need: layer=>host.need?.(layer),
            serveCustomActions: ()=>host.serveCustomActions?.(thread) ?? Promise.resolve(1),
        });
        try
        {
            const commandLine = host.readWideString(
                await call('KERNEL32.dll', 'GetCommandLineW', []), MAX_COMMAND_LINE * 2);
            return (await body(contextFor(commandLine), contextFor)) >>> 0;
        }
        finally
        {
            held.forEach(at=>host.free(at));
        }
    };
    /** @param {(context: import('./msiexec.js').ProgramContext) => Promise<number>} run */
    const program = run=>()=>asProgram(context=>run(context));

    return {
        ...Object.fromEntries([...SYSTEM_PROGRAMS.values(), ...PROGRAMS_IN_PLACE]
            .map(({ routine, run })=>[routine, { argBytes: 0, handler: program(run) }])),
        // The logon's RunOnce pass, called by the first process's start before
        // its program (`synthesiseProcessInit`'s prelude).
        [RUN_ONCE_ROUTINE]: { argBytes: 0, handler: ()=>asProgram((context, contextFor)=>
            runOnceAtLogon(context, contextFor, (api, detail)=>host.divergence?.(api, detail))) },
    };
}
