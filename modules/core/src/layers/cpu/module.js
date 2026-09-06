/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createV86Host } from './internal/v86-host.js';
import { createThunkTable } from './internal/thunks.js';
import { captureContext, restoreContext, setThreadBase } from './internal/context.js';

/**
 * cpu — the guest CPU and the channel the guest calls us through.
 *
 * The only layer that knows an emulator is underneath. Everything above it
 * talks about running, stopping, registers, physical memory and traps.
 *
 * State lives on the module rather than in the returned API because
 * `diagnostics()` is part of the module contract and has to answer after the
 * instance exists. One build per process is the assumption; a second concurrent
 * build would need this hoisted into a per-instance record.
 */

/** @type {any} */
let host = null;
/** @type {any} */
let thunks = null;
let running = false;

export const cpuModule = {
    name: 'cpu',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ ([]),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        const settings = {
            memorySize: config?.memorySize ?? 64 * 1024 * 1024,
            trapPort: config?.trapPort ?? 0xb077,
            entryVector: config?.entryVector ?? 0x7000,
            initialStack: config?.initialStack ?? 0x300000,
            thunkBase: config?.thunkBase ?? 0x200000,
        };

        /** @type {(id: number) => void} */
        let dispatch = ()=>{};

        /** Every entry point that needs a running emulator goes through this. */
        const started = ()=>{
            if (!host)
            {
                throw new Error('cpu: boot() must be called before the guest can run');
            }
            return host;
        };

        return {
            layout: {
                entryVector: settings.entryVector,
                initialStack: settings.initialStack,
                thunkBase: settings.thunkBase,
            },

            /**
             * Starts the emulator.
             *
             * Separate from `create` on purpose: building the module graph should
             * be cheap and should not require the several megabytes of vendor
             * artifacts, so that a consumer can inspect a build -- or run one with
             * the guest never started -- without paying for an emulator.
             *
             * @param {Object} artifacts
             * @param {string} artifacts.moduleUrl
             * @param {ArrayBuffer} artifacts.wasmBytes
             */
            async boot({ moduleUrl, wasmBytes }){
                if (host)
                {
                    throw new Error('cpu: already booted');
                }
                host = await createV86Host({ ...settings, moduleUrl, wasmBytes });
                thunks = createThunkTable({ base: settings.thunkBase, port: settings.trapPort });
                host.onTrap((/** @type {number} */ id)=>dispatch(id));
            },

            booted: ()=>host !== null,

            run(){
                running = true;
                started().run();
            },

            stop(){
                running = false;
                if (host)
                {
                    host.stop();
                }
            },

            /** @param {number} address @param {number} length */
            readPhysical: (address, length)=>started().readPhysical(address, length),
            /** @param {number} address @param {Uint8Array} bytes */
            writePhysical: (address, bytes)=>started().writePhysical(address, bytes),
            /** @param {string} name */
            readReg32: name=>started().readReg32(name),
            /** @param {string} name @param {number} value */
            writeReg32: (name, value)=>started().writeReg32(name, value),

            /**
             * Takes a stub slot and returns the trap id it raises together with
             * the guest address that raises it. Stubs are laid out contiguously,
             * so the table has to be written into guest memory once every
             * function is registered.
             *
             * What the id means is not this layer's business -- it emits the
             * stub and reports the number.
             *
             * @param {string} name
             * @param {number} popBytes
             * @param {Object} [options]
             * @param {boolean} [options.preserveResult]  For a stub reached by a `ret`.
             * @returns {{ id: number, address: number }}
             */
            registerTrap(name, popBytes, options){
                started();
                return thunks.register(name, popBytes, options);
            },

            /** @returns {Uint8Array} the stub table, to be written at layout.thunkBase */
            thunkImage: ()=>started() && thunks.image(),
            /** Where a terminating call returns to instead of into its caller. */
            parkAddress: ()=>thunks.parkAddress,

            /** @param {(id: number) => void} handler */
            onTrap(handler){
                dispatch = handler;
            },

            /**
             * Runs at most `maxInstructions` and reports how many were retired.
             *
             * This is the scheduler's unit of progress. It is bounded by guest
             * instructions rather than wall clock, so the preemption point does
             * not move with host speed. Granularity is one page: the JIT compiles
             * per 4 KiB page and a slice runs to the end of the page it is in.
             *
             * @param {number} maxInstructions
             * @returns {number}
             */
            runSlice(maxInstructions){
                running = true;
                return started().cpu().run_slice(maxInstructions) >>> 0;
            },

            /** @returns {any} the running thread's full CPU state */
            captureContext: ()=>captureContext(started().cpu()),

            /**
             * Points a saved context at where a parked thread should carry on,
             * with the value its blocking call is about to return.
             *
             * A thread that blocked did not stop at a random place: its stub was
             * redirected to the park loop and its real return address kept aside,
             * because the loop is a parking slot, not code the thread should
             * resume into. This puts it back on the road.
             *
             * A stack pointer comes with it when the thread is being sent
             * somewhere it has not been -- into a guest callback, whose frame the
             * host built below where the thread stopped. A wait resumes on its
             * own stack and leaves it alone.
             *
             * @param {any} context
             * @param {Object} options
             * @param {number} options.eip
             * @param {number} options.returnValue
             * @param {number | null} [options.esp]
             */
            resumeContextAt(context, { eip, returnValue, esp = null }){
                context.eip = eip;
                context.reg32[0] = returnValue | 0; // EAX
                if (esp !== null)
                {
                    context.reg32[4] = esp | 0; // ESP
                }
                context.inHlt = 0;
            },

            /**
             * Restores a thread, including the base of its TEB.
             *
             * The TEB address is a parameter rather than something the caller sets
             * beforehand, so that resuming a thread without moving FS to that
             * thread's TEB is not expressible (§12.5).
             *
             * @param {any} context
             * @param {number} threadBase
             */
            restoreContext(context, threadBase){
                setThreadBase(context, threadBase);
                restoreContext(started().cpu(), context);
            },

            /**
             * A context for a thread that has not run yet: the current CPU state
             * as a template -- segments, control words and the rest of the process
             * environment -- positioned at its own entry point and stack.
             *
             * @param {Object} options
             * @param {number} options.entry
             * @param {number} options.stackTop
             * @returns {any}
             */
            newContext({ entry, stackTop }){
                const context = captureContext(started().cpu());
                context.eip = entry;
                context.reg32[4] = stackTop; // ESP
                context.reg32[5] = stackTop; // EBP
                context.inHlt = 0;
                return context;
            },

            instructionCount: ()=>started().instructionCount(),
            inProtectedMode: ()=>started().inProtectedMode(),
            eip: ()=>started().eip(),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'cpu',
            version: '0.1.0',
            status: host ? 'ready' : 'created',
            metrics: {
                running,
                instructions: host ? host.instructionCount() : 0,
                protectedMode: host ? host.inProtectedMode() : false,
                traps: thunks ? thunks.size : 0,
            },
        };
    },

    async dispose(){
        if (host)
        {
            host.stop();
        }
        host = null;
        thunks = null;
        running = false;
    },
};
