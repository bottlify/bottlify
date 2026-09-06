/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { createV86Host } from './internal/v86-host.js';
import { createThunkTable } from './internal/thunks.js';

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
             * Registers a host implementation and returns the guest address that
             * reaches it. Stubs are laid out contiguously, so the table has to be
             * written into guest memory once every function is registered.
             *
             * @param {string} name
             * @param {number} argBytes
             * @param {Function} handler
             * @returns {number}
             */
            registerTrap(name, argBytes, handler){
                started();
                return thunks.register(name, argBytes, handler);
            },

            /** @returns {Uint8Array} the stub table, to be written at layout.thunkBase */
            thunkImage: ()=>started() && thunks.image(),
            /** @param {number} id */
            lookupTrap: id=>thunks.lookup(id),
            /** Where a terminating call returns to instead of into its caller. */
            parkAddress: ()=>thunks.parkAddress,

            /** @param {(id: number) => void} handler */
            onTrap(handler){
                dispatch = handler;
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
