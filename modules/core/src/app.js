/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { assembleModules } from './core.js';
import { createEvents } from './events.js';

/**
 * createApp — the consumer-facing entry point: run a Win32 application.
 *
 * Everything below it is the module graph; this is the one place that wires the
 * cross-cutting step the graph deliberately does not express. An executable's
 * imports have to become guest addresses that call into win32, but win32 does
 * not know what a guest call looks like and the bridge does not know what win32
 * implements. Neither should. Assembling a process is what knows both.
 */

/**
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} v86                 Emulator artifacts.
 * @property {string} v86.moduleUrl
 * @property {ArrayBuffer} v86.wasmBytes
 * @property {number} [stackSize]
 */

/**
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    const events = createEvents();

    const core = await assembleModules({
        win32: {
            /** @param {number} handle @param {string} text */
            onOutput: (handle, text)=>events.emit('output', { handle, text }),
            /** @param {string} text */
            onTrace: text=>events.emit('debug', { text }),
        },
    });

    const cpu = core.api('cpu');
    const memory = core.api('memory');
    const kernel = core.api('kernel');
    const loader = core.api('loader');
    const win32 = core.api('win32');
    const bridge = core.api('bridge');

    await cpu.boot(options.v86);

    const { entryVector, initialStack, thunkBase } = cpu.layout;
    const stackSize = options.stackSize ?? 0x10000;

    memory.register({
        name: 'entry-vector', base: entryVector, size: 4,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'stack', base: initialStack - stackSize, size: stackSize,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE,
    });

    // Binding imports registers stubs, so the table's size is only known here.
    const image = loader.load(options.executable, {
        resolveImport: (/** @type {string} */ dll, /** @type {string | null} */ name)=>{
            const fn = win32.resolve(name ?? '');
            if (!fn)
            {
                return null;
            }
            return bridge.register(`${dll}!${name}`, fn);
        },
    });

    const stubs = cpu.thunkImage();
    memory.register({
        name: 'thunks', base: thunkBase, size: stubs.length,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Written once; from here a write into the stubs would be corruption.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    memory.writeU32(entryVector, image.entryPoint);

    // The program's first thread. Everything after this runs under the
    // scheduler, including the main thread -- there is no privileged path.
    const mainThread = kernel.createThread({
        entry: image.entryPoint,
        stackTop: initialStack,
        name: 'main',
    });

    /**
     * Pausing is a gate rather than a flag polled in a loop: a paused caller
     * waits on a promise that resuming resolves, so nothing spins.
     *
     * @type {{ gate: Promise<void>, open: () => void } | null}
     */
    let paused = null;

    // attachLog is sugar over the registry: the same subscription, remembered
    // by the sink the caller gave, so detaching still takes what it was given.
    /** @type {Map<Function, (payload: any) => void>} */
    const logSinks = new Map();

    /**
     * Announces a failure the program itself cannot see, and hands back what to
     * throw. A handler may answer with an error of its own to throw instead.
     *
     * @param {string} reason
     * @param {Error} error
     * @returns {Error}
     */
    const fail = (reason, error)=>events.emit('error', { reason, error }) ?? error;

    return {
        /** Where the program was mapped and where it starts. */
        image,

        /**
         * Runs the program to completion, one scheduler turn at a time.
         *
         * Turns rather than a free-running emulator: a turn is where a thread
         * can be preempted, where a blocked one is put back on the road, and
         * where "nothing can run" becomes visible instead of looking like work.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         * @returns {Promise<number>} the guest's exit code
         */
        async run({ maxTurns = 200000 } = {}){
            for (let turn = 0; turn < maxTurns; turn++)
            {
                if (paused)
                {
                    await paused.gate;
                }

                // One yield per turn, so a host function suspended on a guest
                // callback can make progress between them. Without it the loop
                // never returns to the event loop on its normal path and such a
                // handler would be resumed exactly never.
                await Promise.resolve();

                const failure = bridge.failure();
                if (failure)
                {
                    throw fail('host-call', failure);
                }

                const code = win32.exitCode();
                if (code !== null)
                {
                    events.emit('exit', { code });
                    return code;
                }

                const step = kernel.runOnce();
                if (!step.ran)
                {
                    // Nobody is ready. Either everything finished without the
                    // program exiting, or every thread is waiting on something
                    // no one will signal -- and the diagnostics name what.
                    const waiting = kernel.diagnosticsSnapshot().waiting;
                    if (waiting.length > 0)
                    {
                        throw fail('deadlock', new Error(`deadlock: ${waiting.join('; ')}`));
                    }
                    throw fail('no-threads',
                        new Error('every thread ended without the process exiting'));
                }
            }
            throw fail('runaway',
                new Error(`program did not finish within ${maxTurns} turns`));
        },

        /** The program's first thread. */
        mainThread,

        /**
         * Stops handing out turns without ending anything; `resume` continues
         * from the same place, since no thread's state was touched.
         */
        pause(){
            if (paused)
            {
                return;
            }
            /** @type {() => void} */
            let open = ()=>{};
            const gate = new Promise(resolve=>{
                open = ()=>resolve(undefined);
            });
            paused = { gate, open };
        },
        resume(){
            if (!paused)
            {
                return;
            }
            paused.open();
            paused = null;
        },
        stop: ()=>cpu.stop(),

        /**
         * Watches, answers, or swallows something the program did.
         *
         * Handlers run in registration order and the first to return anything
         * other than `undefined` decides and stops the rest -- so observing and
         * intercepting are the same mechanism, and a handler that returns
         * nothing has not intervened.
         *
         * What is emitted today: `output` ({ handle, text }) for a write to a
         * standard handle, `debug` ({ text }) for the program's own tracing,
         * `error` ({ reason, error }) for a failure the program cannot see,
         * and `exit` ({ code }) when it ends.
         *
         * @param {string} name
         * @param {(payload: any) => any} handler
         * @returns {() => void} stops this handler
         */
        on: (name, handler)=>events.on(name, handler),
        /** @param {string} name @param {(payload: any) => any} handler */
        off: (name, handler)=>events.off(name, handler),

        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            /** @param {any} payload */
            const handler = payload=>{
                sink(payload.handle, payload.text);
            };
            logSinks.set(sink, handler);
            events.on('output', handler);
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            const handler = logSinks.get(sink);
            if (handler)
            {
                events.off('output', handler);
                logSinks.delete(sink);
            }
        },

        exitCode: ()=>win32.exitCode(),
        diagnostics: ()=>[
            ...core.diagnostics(),
            { name: 'app', version: '0.1.0', status: 'ready', metrics: events.diagnostics() },
        ],
        dispose: ()=>core.dispose(),
    };
}
