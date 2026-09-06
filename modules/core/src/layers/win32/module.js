/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createConsoleFunctions } from './kernel32/console.js';
import { createThreadingFunctions } from './kernel32/threading.js';
import { createDebugFunctions } from './kernel32/debug.js';
import { createMsvcrtFunctions } from './msvcrt/functions.js';

/**
 * win32 — the API surface the guest was compiled against.
 *
 * Phase 1 implements only what a console program needs to say something and
 * exit; the rest of kernel32, and user32/gdi32/advapi32 besides, arrive with
 * the Win32 phase proper.
 *
 * The module exposes a table of `name -> { argBytes, handler }` rather than
 * registering anything itself: it does not know how a guest call reaches the
 * host, and should not. Whoever assembles the process binds this table to the
 * bridge.
 */

/** @type {Record<string, { argBytes: number, handler: Function }>} */
let functions = {};
/** @type {number | null} */
let exitCode = null;

export const win32Module = {
    name: 'win32',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ ([
        'bridge',
        'kernel',
        'memory',
        'loader',
        'filesystem',
        'log',
    ]),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');
        const kernel = host.requireApi('kernel');
        const bridge = host.requireApi('bridge');
        exitCode = null;

        /** @type {(handle: number, text: string) => void} */
        const sink = config?.onOutput ?? (()=>{});
        /** @type {(text: string) => void} */
        const trace = config?.onTrace ?? (()=>{});

        functions = {
            ...createConsoleFunctions({
                readMemory: (address, length)=>memory.readBytes(address, length),
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                write: (handle, text)=>sink(handle, text),
                exit: code=>{
                    exitCode = code;
                },
                park: ()=>bridge.park(),
            }),
            ...createDebugFunctions({
                readCString: (address, maxLength)=>memory.readCString(address, maxLength),
                readWideString: (address, maxLength)=>
                    memory.readWideString(address, maxLength),
                say: text=>trace(text),
            }),
            ...createThreadingFunctions({
                kernel,
                readMemory: (address, length)=>memory.readBytes(address, length),
                currentThread: ()=>kernel.currentThread(),
                park: thread=>bridge.park(thread),
            }),
            ...createMsvcrtFunctions({
                readMemory: (address, length)=>memory.readBytes(address, length),
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                readCString: (address, maxLength)=>memory.readCString(address, maxLength),
                write: (handle, text)=>sink(handle, text),
                callGuest: (entry, args)=>bridge.callGuest({ entry, args }),
            }),
        };

        return {
            /**
             * The guest-callable surface, keyed the way an import table names it.
             *
             * @returns {Record<string, { argBytes: number, handler: Function }>}
             */
            exports: ()=>functions,

            /**
             * @param {string} name
             * @returns {{ argBytes: number, handler: Function } | null}
             */
            resolve: name=>functions[name] ?? null,

            /** Set once the guest has asked to terminate. */
            exitCode: ()=>exitCode,
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'win32',
            version: '0.1.0',
            status: Object.keys(functions).length > 0 ? 'ready' : 'created',
            metrics: {
                implemented: Object.keys(functions),
                exitCode,
            },
        };
    },

    async dispose(){
        functions = {};
        exitCode = null;
    },
};
