/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createV86Host } from './internal/v86-host.js';
import { createFpu } from './internal/fpu.js';
import { createThunkTable, FORWARD_SAVE } from './internal/thunks.js';
import { FAULT_TRAP_BASE, ROM_BASE, ROM_SIZE } from './internal/boot-rom.js';
import { readFault, describeFault } from './internal/faults.js';

/**
 * The exception that stopped the machine, if one did.
 *
 * Kept rather than raised: a fault is reported from inside the emulator's own
 * port write, and an exception thrown there is lost crossing back into wasm.
 *
 * @type {any}
 */
let lastFault = null;
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
/** Whether the stub table has been put into guest memory yet. */
let tableWritten = false;

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
            // Half a gigabyte, because that is the order a program of this era
            // expects once it starts loading its own data. Two different things
            // run out, and both of them here: the address space, since system
            // modules are placed a megabyte apart and a game's own libraries
            // are megabytes each, and the memory itself, since a title loads
            // its textures, models and sound into the heap and asks for
            // hundreds of megabytes of it. Must stay a power of two -- the
            // emulator requires it.
            memorySize: config?.memorySize ?? 512 * 1024 * 1024,
            trapPort: config?.trapPort ?? 0xb077,
            entryVector: config?.entryVector ?? 0x7000,
            initialStack: config?.initialStack ?? 0x300000,
            // Low, so that everything between here and the initial stack
            // pointer belongs to the stack. A program linked for a megabyte
            // needs a megabyte below that pointer, and the stubs sitting in
            // the middle of that span would cap it at less.
            thunkBase: config?.thunkBase ?? 0x100000,
            // Sixteen thousand stubs. Every import of every library takes one,
            // and so does every method of every COM interface a program asks
            // for -- which is unbounded in principle and in the low thousands
            // in practice.
            thunkCapacity: config?.thunkCapacity ?? 16384 * 16,
            // The emulator's compiler budgets, by index, for a caller that
            // wants to A/B them: 1 is how many pages one compiled module may
            // span, 3 how many extra basic blocks discovery may follow. The
            // defaults are small, and a program that leaves generated code
            // every few dozen instructions pays the dispatch walk each time.
            jit: config?.jit,
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

        const fpu = createFpu({ get wasm_memory(){ return started().cpu().wasm_memory; } });

        return {
            layout: {
                entryVector: settings.entryVector,
                initialStack: settings.initialStack,
                thunkBase: settings.thunkBase,
                // Room for every stub this process will ever take, not just the
                // ones taken before the table was first written.
                thunkCapacity: settings.thunkCapacity,
                // What anything placing an image has to fit inside. A base
                // chosen without it is a guess about how much memory the
                // machine was given, and a wrong guess writes past the end.
                memorySize: settings.memorySize,
                // Where our own boot ROM sits. Worth registering as a region
                // by whoever lays out memory: a fault leaves the processor
                // standing in the stub behind its vector, and a report that
                // cannot name that address calls the engine's own code
                // unmapped -- which is the one place a reader should not be
                // sent to look for a guest's bug.
                romBase: ROM_BASE,
                romSize: ROM_SIZE,
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
                lastFault = null;
                host = await createV86Host({ ...settings, moduleUrl, wasmBytes });
                thunks = createThunkTable({
                    base: settings.thunkBase,
                    port: settings.trapPort,
                    // The same span the region is registered with, so the table
                    // refuses a slot rather than laying one outside it.
                    capacity: settings.thunkCapacity,
                });
                host.onTrap((/** @type {number} */ id)=>{
                    // A processor exception arrives as a trap like any other,
                    // from a stub the ROM put behind its vector. Answered here
                    // rather than passed on, because the layer that owns the
                    // interrupt table is the one that knows what the numbers
                    // mean, and because a fault handed to the call dispatcher
                    // would come back as "trap has no implementation" -- true,
                    // and the wrong thing to have been told.
                    const vector = id - FAULT_TRAP_BASE;
                    if (vector >= 0 && vector < 32)
                    {
                        const fault = readFault(
                            vector,
                            host.readReg32('esp'),
                            (/** @type {number} */ address)=>{
                                const bytes = host.readPhysical(address, 4);
                                return bytes[0] | bytes[1] << 8
                                    | bytes[2] << 16 | bytes[3] << 24;
                            },
                        );
                        // Recorded and the machine stopped, never thrown. This
                        // runs inside the emulator's port write, and an
                        // exception raised there does not come back out -- it
                        // is lost crossing into wasm, and what is seen
                        // afterwards is a machine sitting in the stub's halt,
                        // which reads as a hang rather than as a fault.
                        lastFault = fault;
                        host.stop();
                        return 0;
                    }
                    return dispatch(id);
                });
            },

            booted: ()=>host !== null,

            /**
             * The processor exception that stopped the machine, or null.
             *
             * Asked after a run that ended without the program saying it had
             * finished: from outside, a halted processor and a finished program
             * look the same.
             */
            fault: ()=>lastFault && { ...lastFault, text: describeFault(lastFault) },

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
            /** @param {number} address */
            readU32: address=>started().readU32(address),
            /** @param {number} address @param {Uint8Array} bytes */
            writeData: (address, bytes)=>started().writeData(address, bytes),
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
                const taken = thunks.register(name, popBytes, options);
                // Written straight into the guest when the table is already
                // there. Registration never stops -- a COM interface published
                // when a program first asks for it takes a slot per method --
                // and a slot whose bytes were never written is sixteen zeroes
                // that a guest will happily execute.
                if (tableWritten)
                {
                    started().writePhysical(taken.address, thunks.stub(taken.id));
                }
                return taken;
            },

            /**
             * The stub table, to be written at `layout.thunkBase`.
             *
             * Reserve `layout.thunkCapacity` bytes for it rather than the
             * length of what comes back: slots taken later are written in
             * place, and a region sized to the table as it stands today would
             * put every one of them outside the address space.
             *
             * @returns {Uint8Array}
             */
            thunkImage(){
                started();
                tableWritten = true;
                return thunks.image();
            },
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
                const instructions = started().cpu().run_slice(maxInstructions) >>> 0;
                // Folds the emulator's word into the count before it can wrap.
                started().instructionCount();
                return instructions;
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

            /**
             * Decompresses a zstd frame without awaiting anything.
             *
             * Here because the decoder is inside the emulator's wasm and this is
             * the layer allowed to know that. What uses it is the bundle reader,
             * which has to answer a guest's read while the CPU is stopped inside
             * one instruction -- so a promise is not an option.
             *
             * @param {Uint8Array} packed @param {number} expectedLength
             */
            decompressZstd: (packed, expectedLength)=>
                started().decompressZstd(packed, expectedLength),

            instructionCount: ()=>started().instructionCount(),
            compiledModules: ()=>started().compiledModules(),
            interpretedSteps: ()=>started().interpretedSteps(),
            hostWrittenBytes: ()=>started().hostWrittenBytes(),
            /**
             * The emulator's account of where the guest ran, by address and
             * weighted by instructions. Kept only between start and stop, and
             * only by a build that carries it.
             */
            profile: {
                available: ()=>started().profile.available(),
                start: ()=>started().profile.start(),
                stop: ()=>started().profile.stop(),
                read: ()=>started().profile.read(),
            },
            inProtectedMode: ()=>started().inProtectedMode(),
            eip: ()=>started().eip(),
            forwardSave: FORWARD_SAVE,

            /**
             * The floating-point stack, for whoever answers a call that returns
             * a double. Handed out before the guest starts and reached through
             * a getter, so that an assembling caller can wire it at build time
             * and the emulator's memory can still be grown and replaced later.
             */
            fpu,
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
                trapCapacity: thunks ? thunks.capacity : 0,
                // Whether the emulator is compiling guest code at all, and
                // how much of it runs compiled rather than interpreted.
                //
                // Every test this project has passes on a dead compiler: they
                // assert what the guest computed, and an interpreter computes
                // the same answers several times slower. So the one thing that
                // separates a machine running at its speed from one running at
                // a seventh of it is invisible to all of them.
                //
                // Not the emulator's own cache size: that counter is compiled
                // out of a release build and answers zero always, which reads
                // as a dead compiler on a healthy machine. Counted where the
                // instructions are actually retired instead.
                jit: host ? host.jitState() : null,
                // Where the guest is right now. A thread that spins in guest
                // code makes no host call, so nothing else in this report can
                // say what it is doing; sampled repeatedly from outside, this
                // one number names the loop.
                eip: host ? host.eip() : 0,
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
        tableWritten = false;
    },
};
