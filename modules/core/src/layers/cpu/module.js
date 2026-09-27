/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createV86Host } from './internal/v86-host.js';
import { createHybridHost } from './internal/hybrid-host.js';
import { createCorkHost } from './internal/cork-host.js';
import { createDifferentialHost } from './internal/differential-host.js';
import { TABLES_RESERVE } from './engine.js';
import { createFpu } from './internal/fpu.js';
import { createThunkTable, FORWARD_SAVE } from './internal/thunks.js';
import {
    FAULT_TRAP_BASE, ROM_BASE, ROM_SIZE, THREAD_DESCRIPTOR, VECTORS,
} from './internal/boot-rom.js';
import { readFault, describeFault, hostFault } from './internal/faults.js';
import {
    captureContext, freshThreadFpu, restoreContext, setThreadBase,
} from './internal/context.js';
import { createSampleTable, creditSample, topSamples } from './internal/samples.js';
import { fileNameOf } from './internal/translation-store.js';

/**
 * Guest RAM when nobody says otherwise. A gigabyte, because a program of this
 * era that loads a level allocates several hundred megabytes and a machine
 * with less turns that into an out-of-memory failure it reports as its own;
 * a power of two, because the emulator requires it. Reserved rather than
 * committed: the host pays only for what the guest touches.
 */
export const DEFAULT_MEMORY_SIZE = 1024 * 1024 * 1024;

/**
 * The execution engines a launch may select (`engine.js` for the contract).
 *
 * `emulator` is the vendored emulator alone; `hybrid` runs the emulator with
 * a translator taking the regions it has translated, on one register file;
 * `cork` is the translator alone; `differential` is `hybrid` with every
 * region replayed on the emulator and compared, for test builds. The last is
 * named here so a configuration is refused for the right reason -- not built
 * yet, rather than unknown -- until its step lands.
 */
export const ENGINES = Object.freeze(['emulator', 'hybrid', 'cork', 'differential']);

/** The engines a launch can run today. */
const BUILT_ENGINES = new Set(['emulator', 'hybrid', 'cork', 'differential']);

/**
 * The engine a launch that names none runs: the translator. The emulator stays
 * an engine a launch may select, and the reference the differential suites
 * judge the translator against.
 */
export const DEFAULT_ENGINE = 'cork';

/**
 * cpu — the guest CPU and the channel the guest calls us through.
 *
 * The only layer that knows an emulator is underneath. Everything above it
 * talks about running, stopping, registers, physical memory and traps.
 */

/** Where each general register sits in a saved context, in the processor's own order. */
const REGISTER_INDEX = Object.freeze({
    eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7,
});

/**
 * What this layer publishes as numbers, once a frame: the counters the
 * diagnostics table carries at the top level, and the emulator's own
 * counters under `jit.`. Read from the emulator's exports when sampled --
 * nobody keeps them as they change, and reading thirty exports once a frame
 * is nothing -- rather than on every request for them.
 */
const JIT_FIELDS = [
    'disabled', 'maxPages', 'loopSafety', 'cache', 'tableFree', 'compiledSteps',
    'interpretedSteps', 'entries', 'interpretedDispatches', 'f80Conversions', 'codePageWrites',
    'modulesLostToWrites', 'hotnessLostToWrites', 'chaining', 'chained', 'chainMissed',
    'chainRefused', 'flagsDead', 'slowWrites', 'codePageWritesKept', 'x87TagLost',
    // Why the interpreter ran, per frame: the four reasons partition the
    // dispatches, and the steps beside them say which reason the frame actually
    // lost its time to -- a reason taken often for two instructions each and a
    // reason taken rarely for thousands read the same until these are separate.
    'interpNoCode', 'interpNoEntry', 'interpNearPageEnd', 'interpDifferentState',
    'interpNoCodeSteps', 'interpNoEntrySteps', 'interpNearPageEndSteps',
    'interpDifferentStateSteps', 'interpEntryAfterPageWalk',
    'interpBelowThreshold', 'interpCompileDeferred',
    'finalised', 'discarded', 'hostWrites', 'hostWrittenBytes',
];
/** Where this layer's own counters sit, before the emulator's. */
const JIT_AT = 7;
export const CPU_COUNTERS = [
    'running', 'instructions', 'protectedMode', 'traps', 'trapCapacity', 'eip',
    'trapCrossings',
    ...JIT_FIELDS.map(field=>`jit.${field}`),
    // Where the interpreter ran, rather than only how much of it there was.
    // `interpretedSteps` is a count with no address attached, and a frame that
    // lost twenty milliseconds to the interpreter cannot be acted on until the
    // code is named. These two are the frame's, not the run's: the slice that
    // interpreted most since they were last published, and the address that
    // slice began at -- which a reader turns into a module through the regions
    // table, the way it already does for the scheduler's heaviest slice.
    'frameInterpreted', 'frameInterpretedAt',
];
const FRAME_INTERPRETED = JIT_AT + JIT_FIELDS.length;
// The translator's own figures, when one is attached: regions live, regions
// discarded by a write, and the share of retired instructions it ran.
const CORK_AT = FRAME_INTERPRETED + 2;
CPU_COUNTERS.push('cork.regions', 'cork.invalidations', 'cork.share',
    // And the frame's own: the share of its instructions the translator ran,
    // the milliseconds it spent translating in it, the times translated code
    // came back to the host in it -- what a heavy frame is read against.
    'cork.frameShare', 'cork.frameTranslateMs', 'cork.frameLeaves');

/** The cpu layer's module for one graph; see `defaultModules`. */
export function createCpuModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the emulator, the stub table and the fault record
     * belong to the closure `create()` returns, so a second instance in one
     * realm cannot take the first one's machine, and its own `boot()` does
     * not see the first one's emulator when it asks whether it has already
     * booted.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'cpu',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ (['log']),

        /**
         * @param {any} config
         * @param {import('../../system/contract.js').ScopedModuleHost} [moduleHost]
         * @returns {Promise<any>}
         */
        async create(config, moduleHost){
            const log = moduleHost?.requireApi('log');

            // Refused here rather than at boot: a configuration naming an engine
            // that does not exist is a configuration error, and the assembler
            // reports those before any module has a machine to lose.
            /** @type {string} */
            const engine = config?.engine ?? DEFAULT_ENGINE;
            if (!ENGINES.includes(engine))
            {
                throw new Error(`cpu: unknown engine "${engine}" (${ENGINES.join(', ')})`);
            }
            if (!BUILT_ENGINES.has(engine))
            {
                throw new Error(`cpu: engine "${engine}" is not built yet`);
            }

            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own emulator, stub table and fault record. `host`/`thunks` double
             * as the "has this instance booted" flag: `boot()`'s "already
             * booted" refusal and every method that needs a running emulator
             * read them, and only them, never a different instance's.
             *
             * @type {{ host: any, thunks: any, running: boolean, tableWritten: boolean,
             *          worstInterpreted: number, worstInterpretedAt: number,
             *          interpretedBefore: number, lastFault: any, disposed: boolean,
             *          samples: ReturnType<typeof createSampleTable>, engine: string,
             *          cork: import('./engine.js').Runtime | null,
             *          corkFrame: { instructions: number, retired: number, translateMs: number,
             *              leaves: number },
             *          faultHandler: ((fault: any) => boolean) | null,
             *          guestClock: (() => number) | null }}
             */
            const state = {
                host: null, thunks: null, running: false, tableWritten: false,
                worstInterpreted: 0, worstInterpretedAt: 0, interpretedBefore: 0,
                lastFault: null, disposed: false, samples: createSampleTable(), engine,
                cork: null,
                faultHandler: null,
                // The guest's clock once the kernel gives it (`useGuestClock`).
                guestClock: null,
                // The translator's figures at the last frame, for the frame's own columns.
                corkFrame: { instructions: 0, retired: 0, translateMs: 0, leaves: 0 },
            };
            /**
             * Once a frame: every bucket the sampler has credited past the
             * threshold becomes a candidate for the translator, and the pending
             * batch is instantiated -- paced by frames, never inside a slice.
             */
            const feedTranslator = ()=>{
                const cork = state.cork;
                if (!cork)
                {
                    return;
                }
                const hotThreshold = settings.cork.hotThreshold ?? 2000;
                for (const bucket of state.samples.buckets.values())
                {
                    // A hot bucket is handed over at the address its last slice
                    // ended on, every time that address is a new one: a bucket
                    // ends its slices at more than one place (a loop's head, the
                    // stub it calls), and the first of them said nothing about
                    // the others. The runtime keeps what it has an entry for,
                    // has queued, or found empty.
                    if (bucket.instructions >= hotThreshold && bucket.noted !== bucket.eip)
                    {
                        bucket.noted = bucket.eip;
                        cork.noteHot(bucket.eip, state.host.x87Top());
                    }
                }
                // Always: the translator queues candidates of its own (the
                // addresses it keeps leaving for) between feeds.
                cork.translatePending().catch(()=>{});
            };

            // Always on, because the whole point is never having to reproduce a
            // heavy frame under a second run just to find out where it went --
            // the cost this pays every slice is a register read and a table
            // update, measured to leave the guest phase's ms/frame unchanged. A
            // caller measuring the emulator itself (a JIT budget comparison) can
            // still turn it off.
            const samplingEnabled = config?.sampling !== false;

            if (typeof log?.metrics?.counters === 'function')
            {
                const counters = log.metrics.counters('cpu', CPU_COUNTERS);
                log.metrics.onFrame(()=>{
                    if (!state.host)
                    {
                        return;
                    }
                    counters[0] = state.running ? 1 : 0;
                    counters[1] = state.host.instructionCount();
                    counters[2] = state.host.inProtectedMode() ? 1 : 0;
                    counters[3] = state.thunks ? state.thunks.size : 0;
                    counters[4] = state.thunks ? state.thunks.capacity : 0;
                    counters[5] = state.host.eip();
                    counters[6] = state.host.trapCrossings();
                    feedTranslator();
                    if (state.cork)
                    {
                        const cork = state.cork.counters();
                        counters[CORK_AT] = cork.regions;
                        counters[CORK_AT + 1] = cork.invalidations;
                        counters[CORK_AT + 2] = cork.translatedShare;
                        const leaves = cork.exits.untranslated + cork.exits.budget + cork.exits.trap
                            + cork.exits.halt + cork.exits.fault + cork.exits.stale
                            + (cork.exits.interpreted ?? 0);
                        const instructions = state.host.instructionCount();
                        const last = state.corkFrame;
                        const ran = instructions - last.instructions;
                        counters[CORK_AT + 3] = ran > 0 ? (cork.retired - last.retired) / ran : 0;
                        counters[CORK_AT + 4] = cork.translateMs - last.translateMs;
                        counters[CORK_AT + 5] = leaves - last.leaves;
                        state.corkFrame = {
                            instructions, retired: cork.retired, translateMs: cork.translateMs,
                            leaves,
                        };
                    }
                    const jit = state.host.jitState();
                    // An emulator that refused to answer reports `-1` rather than a
                    // record, and reading fields off a number leaves every counter
                    // NaN -- which a frame's own figures are then subtracted from.
                    if (jit && typeof jit === 'object')
                    {
                        for (let field = 0; field < JIT_FIELDS.length; field++)
                        {
                            const value = jit[JIT_FIELDS[field]];
                            counters[JIT_AT + field] = typeof value === 'number'
                                ? value : Number(value);
                        }
                    }
                    else
                    {
                        // No emulator compiler on this engine (`cork`): the columns
                        // are kept and say `-1`, not the zero a never-read counter
                        // would look like a dead compiler by.
                        for (let field = 0; field < JIT_FIELDS.length; field++)
                        {
                            counters[JIT_AT + field] = -1;
                        }
                    }
                    counters[FRAME_INTERPRETED] = state.worstInterpreted;
                    counters[FRAME_INTERPRETED + 1] = state.worstInterpretedAt;
                    state.worstInterpreted = 0;
                    state.worstInterpretedAt = 0;
                });
            }
            const settings = {
                // Half a gigabyte, because that is the order a program of this era
                // expects once it starts loading its own data. Two different things
                // run out, and both of them here: the address space, since system
                // modules are placed a megabyte apart and a game's own libraries
                // are megabytes each, and the memory itself, since a title loads
                // its textures, models and sound into the heap and asks for
                // hundreds of megabytes of it. Must stay a power of two -- the
                // emulator requires it.
                memorySize: config?.memorySize ?? DEFAULT_MEMORY_SIZE,
                // The translator's module, imported at boot for `hybrid`; absent,
                // hybrid runs with no translator attached.
                engineUrl: config?.engineUrl ?? null,
                /** @type {import('./engine.js').EngineConfig} */
                cork: config?.cork ?? {},
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

            /** Every entry point that needs a running machine goes through this. */
            const started = ()=>{
                if (!state.host)
                {
                    throw new Error('cpu: boot() must be called before the guest can run');
                }
                return state.host;
            };

            const takeHostFault = ()=>{
                if (state.lastFault === null && state.host
                    && typeof state.host.fault === 'function')
                {
                    state.lastFault = state.host.fault();
                }
            };

            const captureCurrentContext = ()=>{
                const host = started();
                return typeof host.captureContext === 'function'
                    ? host.captureContext()
                    : captureContext(host.cpu());
            };

            const emulatorFpu = createFpu({
                get wasm_memory(){ return started().cpu().wasm_memory; },
            });
            const activeFpu = ()=>{
                const host = started();
                return typeof host.fpu === 'function' ? host.fpu() : emulatorFpu;
            };
            const fpu = {
                /** @param {number} value */
                setResult: value=>activeFpu().setResult(value),
                /** @param {number} index */
                get: index=>activeFpu().get(index),
                pop: ()=>activeFpu().pop(),
                depth: ()=>activeFpu().depth(),
                controlWord: ()=>activeFpu().controlWord(),
            };

            current = state;
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
                    // Under hybrid the top of the emulator's RAM is the tables';
                    // cork allocates its state block and tables beside the guest's
                    // full RAM, so nothing is carved out of it.
                    memorySize: engine === 'cork'
                        ? settings.memorySize
                        : settings.memorySize - (engine === 'emulator' ? 0 : TABLES_RESERVE),
                    // Where our own boot ROM sits. Worth registering as a region
                    // by whoever lays out memory: a fault leaves the processor
                    // standing in the stub behind its vector, and a report that
                    // cannot name that address calls the engine's own code
                    // unmapped -- which is the one place a reader should not be
                    // sent to look for a guest's bug. Cork has no ROM.
                    romBase: engine === 'cork' ? -1 : ROM_BASE,
                    romSize: engine === 'cork' ? 0 : ROM_SIZE,
                },

                /**
                 * Starts the selected engine.
                 *
                 * Separate from `create` on purpose: building the module graph should
                 * be cheap and should not require the several megabytes of vendor
                 * artifacts, so that a consumer can inspect a build -- or run one with
                 * the guest never started -- without paying for an emulator.
                 *
                 * Throws if *this instance* has already booted. A different
                 * instance that has booted -- the one a process replacement is
                 * retiring, say -- has no bearing on this one: each keeps its own
                 * machine, and only its own.
                 *
                 * Under `cork`, no emulator artifact is fetched or instantiated; the
                 * translator module named by `engineUrl` supplies the host's own
                 * memory and runtime.
                 *
                 * @param {Object} [artifacts]
                 * @param {string} [artifacts.moduleUrl]
                 * @param {ArrayBuffer} [artifacts.wasmBytes]
                 */
                async boot(artifacts = {}){
                    if (state.host)
                    {
                        throw new Error('cpu: already booted');
                    }
                    state.lastFault = null;
                    if (engine === 'cork')
                    {
                        if (!settings.engineUrl)
                        {
                            throw new Error('cpu: engine "cork" needs an engineUrl');
                        }
                        const engineModule = await import(settings.engineUrl);
                        state.host = createCorkHost({
                            engine: engineModule,
                            memorySize: settings.memorySize,
                            trapPort: settings.trapPort,
                            entryVector: settings.entryVector,
                            initialStack: settings.initialStack,
                            cork: settings.cork,
                        });
                        state.cork = state.host.cork();
                        if (state.guestClock !== null)
                        {
                            state.host.useGuestClock(state.guestClock);
                        }
                    }
                    else
                    {
                        const { moduleUrl, wasmBytes } = artifacts;
                        if (!moduleUrl || !wasmBytes)
                        {
                            // A build without the emulator's artifacts, or a launch
                            // that named none: the optional layer is not there.
                            throw new Error('cpu: the emulator is not available in this'
                                + ` build (engine "${engine}" needs it)`);
                        }
                        const emulator = await createV86Host({ ...settings, moduleUrl, wasmBytes });
                        // Under `hybrid` the emulator's host is composed with the
                        // translator's runtime, built over the emulator's own memory
                        // and register file by the module the configuration names.
                        // Without one the composition is the emulator's host under
                        // another name, which runs a program exactly as the emulator
                        // alone does. `differential` is the same composition plus a
                        // replay of every region on the emulator, so it loads the
                        // module's snapshot machinery too.
                        let engineModule = null;
                        const corkLayout = emulator.stateLayout(TABLES_RESERVE);
                        if ((engine === 'hybrid' || engine === 'differential')
                            && settings.engineUrl)
                        {
                            engineModule = await import(settings.engineUrl);
                            const { createEngine } = engineModule;
                            state.cork = createEngine({
                                memory: emulator.wasmMemory(),
                                layout: corkLayout,
                                // A differential build logs every store's old bytes, so the
                                // replay can rewind the translator's writes first.
                                config: { trapPort: settings.trapPort, ...settings.cork,
                                    ...(engine === 'differential' ? { undoLog: true } : {}) },
                                read: emulator.readByte,
                                imports: {
                                    // The call channel from inside translated code:
                                    // the handler the port write reaches, on the
                                    // register file the region wrote back; 1 when it
                                    // moved EIP or stopped the machine, so the region
                                    // leaves rather than going on.
                                    trap: (/** @type {number} */ value)=>{
                                        const at = emulator.eip();
                                        emulator.raiseTrap(value);
                                        return emulator.eip() !== at || emulator.halted() ? 1 : 0;
                                    },
                                    getEflags: emulator.getEflags,
                                    x87Read: ()=>0,
                                    rdtsc: ()=>emulator.readTsc(),
                                    handoffPage: emulator.handoffPage,
                                    handoffHash: emulator.handoffHash,
                                    dirtyCode: emulator.dirtyCode,
                                },
                            });
                        }
                        state.host = engine === 'hybrid'
                            ? createHybridHost({ emulator, cork: state.cork })
                            : engine === 'differential'
                                ? createDifferentialHost({
                                    emulator, cork: state.cork, engine: engineModule,
                                    memory: emulator.wasmMemory(), layout: corkLayout,
                                })
                                : emulator;
                    }
                    state.thunks = createThunkTable({
                        base: settings.thunkBase,
                        port: settings.trapPort,
                        // The same span the region is registered with, so the table
                        // refuses a slot rather than laying one outside it.
                        capacity: settings.thunkCapacity,
                    });
                    state.host.onTrap((/** @type {number} */ id)=>{
                        // A processor exception arrives as a trap like any other,
                        // from a stub the ROM put behind its vector. Answered here
                        // rather than passed on, because the layer that owns the
                        // interrupt table is the one that knows what the numbers
                        // mean, and because a fault handed to the call dispatcher
                        // would come back as "trap has no implementation" -- true,
                        // and the wrong thing to have been told.
                        const vector = id - FAULT_TRAP_BASE;
                        if (engine !== 'cork' && vector >= 0 && vector < VECTORS)
                        {
                            const fault = readFault(
                                vector,
                                state.host.readReg32('esp'),
                                (/** @type {number} */ address)=>{
                                    const bytes = state.host.readPhysical(address, 4);
                                    return bytes[0] | bytes[1] << 8
                                        | bytes[2] << 16 | bytes[3] << 24;
                                },
                            );
                            // Offered first to whoever can deliver it to the
                            // program: a guest that faults on purpose -- probing
                            // a pointer, catching its own divide by zero -- has a
                            // handler for it, and one that claims the fault has
                            // also decided where the thread goes next.
                            if (state.faultHandler?.(fault) === true)
                            {
                                return 0;
                            }
                            // Recorded and the machine stopped, never thrown. This
                            // runs inside the emulator's port write, and an
                            // exception raised there does not come back out -- it
                            // is lost crossing into wasm, and what is seen
                            // afterwards is a machine sitting in the stub's halt,
                            // which reads as a hang rather than as a fault.
                            state.lastFault = fault;
                            state.host.stop();
                            return 0;
                        }
                        return dispatch(id);
                    });
                    // Cork has no interrupt table and no ROM to trap from: its
                    // tiers build the fault record themselves, and offer it here
                    // the way the ROM's stub offers one above.
                    state.host.onFault?.((/** @type {any} */ fault)=>state.faultHandler?.(fault) === true);
                },

                booted: ()=>state.host !== null,

                /**
                 * The processor exception that stopped the machine, or null.
                 *
                 * Asked after a run that ended without the program saying it had
                 * finished: from outside, a halted processor and a finished program
                 * look the same. Null once this instance is disposed, along with
                 * everything else it never booted.
                 */
                fault(){
                    if (!state.disposed)
                    {
                        takeHostFault();
                    }
                    return state.lastFault
                        && { ...state.lastFault, text: describeFault(state.lastFault) };
                },

                /**
                 * Stops the machine with a fault of the host's own naming, found
                 * by the same poll that finds a processor exception.
                 *
                 * Only the record: this is called from inside a trap, where the
                 * emulator is still standing on the stub and will run its `ret`
                 * regardless. The caller sends that return into the park loop,
                 * whose `hlt` is what actually ends the slice -- the same halt
                 * the ROM's fault stubs end on. A no-op once this instance is
                 * disposed: there is no slice left for the record to explain.
                 *
                 * @param {Omit<Parameters<typeof hostFault>[0], 'vector' | 'errorCode'>} fault
                 */
                raiseFault(fault){
                    if (state.disposed)
                    {
                        return;
                    }
                    state.lastFault ??= hostFault(fault);
                },

                /**
                 * Who is offered a processor exception before it stops the
                 * machine. The handler runs inside the trap, with the processor
                 * standing in the vector's stub: it answers `true` only once it
                 * has sent the thread somewhere else to wait, since the stub
                 * itself goes on to nothing but a halt.
                 *
                 * @param {((fault: import('./internal/faults.js').GuestFault) => boolean) | null} handler
                 */
                onFault(handler){
                    state.faultHandler = handler;
                },

                /**
                 * The translation store as a seed a bundle can carry, kept to the
                 * records this translator's lookups can reach; null without a
                 * store that exports, or before the translator is up.
                 *
                 * @returns {Promise<Uint8Array | null>}
                 */
                async exportTranslations(){
                    const store = /** @type {any} */ (settings.cork?.store);
                    const select = state.cork?.seedRecords;
                    if (typeof store?.exportSeed !== 'function' || typeof select !== 'function')
                    {
                        return null;
                    }
                    return store.exportSeed({
                        select: (/** @type {[string, Uint8Array][]} */ records)=>
                            select(records, fileNameOf),
                    });
                },

                /**
                 * Stops the machine on a processor exception that was offered to
                 * the program and not taken -- reported exactly as one that was
                 * never offered, because to a reader it is the same failure.
                 *
                 * @param {import('./internal/faults.js').GuestFault} fault
                 */
                stopWithFault(fault){
                    if (state.disposed || !state.host)
                    {
                        return;
                    }
                    state.lastFault ??= fault;
                    state.host.stop();
                },

                run(){
                    state.running = true;
                    started().run();
                    takeHostFault();
                },

                stop(){
                    state.running = false;
                    if (state.host)
                    {
                        state.host.stop();
                    }
                },

                /** @param {number} address @param {number} length */
                readPhysical: (address, length)=>started().readPhysical(address, length),
                /** @param {number} address @param {Uint8Array} bytes */
                writePhysical: (address, bytes)=>started().writePhysical(address, bytes),
                /** @param {number} address */
                readU32: address=>started().readU32(address),
                /** @param {number} address */
                readF32: address=>started().readF32(address),
                /** @param {number} address @param {Uint8Array} bytes */
                writeData: (address, bytes)=>started().writeData(address, bytes),
                /** @param {number} address @param {number} value @param {number} length */
                fillData: (address, value, length)=>started().fillData(address, value, length),
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
                    const taken = state.thunks.register(name, popBytes, options);
                    // Written straight into the guest when the table is already
                    // there. Registration never stops -- a COM interface published
                    // when a program first asks for it takes a slot per method --
                    // and a slot whose bytes were never written is sixteen zeroes
                    // that a guest will happily execute.
                    if (state.tableWritten)
                    {
                        started().writePhysical(taken.address, state.thunks.stub(taken.id));
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
                    state.tableWritten = true;
                    return state.thunks.image();
                },
                /** Where a terminating call returns to instead of into its caller. */
                parkAddress: ()=>state.thunks.parkAddress,

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
                    state.running = true;
                    const machine = started();
                    const from = machine.eip();
                    let instructions = 0;
                    try
                    {
                        instructions = machine.runSlice(maxInstructions) >>> 0;
                    }
                    catch (e){
                        // An exception the processor could not deliver. The
                        // emulator has no double fault: a page fault while
                        // pushing the frame for a page fault raises another, and
                        // it recurses until the host's stack is gone -- which
                        // surfaces as a range error naming nothing. What is known
                        // afterwards is still in the machine: EIP was put back on
                        // the instruction that faulted first and never moved, and
                        // CR2 holds the last address that would not translate.
                        if (!(e instanceof RangeError))
                        {
                            throw e;
                        }
                        const eip = machine.eip();
                        const cr2 = machine.controlRegister(2);
                        const cr3 = machine.controlRegister(3);
                        const paging = (machine.controlRegister(0) & 0x80000000) !== 0;
                        state.lastFault ??= hostFault({
                            vector: 8,
                            name: 'double fault',
                            errorCode: 0,
                            eip,
                            detail: `double fault at 0x${eip.toString(16).padStart(8, '0')}:`
                                + ` a page fault at 0x${cr2.toString(16).padStart(8, '0')}`
                                + ' while delivering a fault'
                                + (paging
                                    ? `; paging is on with cr3 0x${cr3.toString(16)}`
                                    : ''),
                        });
                        // Nothing more may run: the next slice would only walk
                        // into the same fault. A halt is what the stub behind a
                        // vector would have ended on, had one been reached.
                        machine.halt();
                    }
                    // Folds the machine's word into the count before it can wrap.
                    machine.instructionCount();
                    takeHostFault();
                    // One counter read and one comparison per slice, so that a
                    // frame can name the code the interpreter was in. The slice is
                    // already thousands of times more expensive than this.
                    const interpreted = machine.interpretedSteps();
                    const ran = interpreted - state.interpretedBefore;
                    state.interpretedBefore = interpreted;
                    if (ran > state.worstInterpreted)
                    {
                        state.worstInterpreted = ran;
                        state.worstInterpretedAt = from;
                    }
                    // Where the slice left the guest, weighted by what it retired
                    // getting there -- the only boundary this layer owns. Only a
                    // slice that ran its whole budget is a sample: it stopped
                    // wherever the guest happened to be. One that ended early
                    // stopped where the guest asked to -- a wait it parked in, a
                    // halt -- and crediting that place with everything the slice
                    // retired charged a frame's hot loop to the call ending it.
                    if (samplingEnabled && instructions >= maxInstructions)
                    {
                        creditSample(state.samples, machine.eip(), instructions);
                    }
                    if (samplingEnabled && instructions > 0 && settings.cork.feed === 'slice')
                    {
                        feedTranslator();
                    }
                    return instructions;
                },

                /**
                 * The guest's clock, for the time-stamp counter: under cork `rdtsc`
                 * then counts nanoseconds of the time QueryPerformanceCounter reads.
                 * The emulator's counter is its own and is not moved by this.
                 *
                 * @param {() => number} readMs  milliseconds of guest time
                 */
                useGuestClock(readMs){
                    state.guestClock = readMs;
                    if (typeof state.host?.useGuestClock === 'function')
                    {
                        state.host.useGuestClock(readMs);
                    }
                },

                /** @returns {any} the running thread's full CPU state */
                captureContext: captureCurrentContext,

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
                 * A frame pointer and the rest come with it only when the thread
                 * is sent into code that reads them before it sets them: a funclet
                 * of an exception handler addresses its parent's locals through
                 * EBP, and the block a handler continues at expects every register
                 * the handler chose.
                 *
                 * @param {any} context
                 * @param {Object} options
                 * @param {number} options.eip
                 * @param {number} options.returnValue
                 * @param {number | null} [options.esp]
                 * @param {Record<string, number> | null} [options.registers]
                 */
                resumeContextAt(context, { eip, returnValue, esp = null, registers = null }){
                    context.eip = eip;
                    context.reg32[0] = returnValue | 0; // EAX
                    if (registers !== null)
                    {
                        for (const [name, value] of Object.entries(registers))
                        {
                            const index = REGISTER_INDEX[/** @type {keyof typeof REGISTER_INDEX} */
                                (name)];
                            if (index !== undefined)
                            {
                                context.reg32[index] = value | 0;
                            }
                        }
                    }
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
                    const host = started();
                    if (typeof host.restoreContext === 'function')
                    {
                        host.restoreContext(context);
                        return;
                    }
                    restoreContext(host.cpu(), context);
                    // The emulator loads a segment's base from its descriptor, so
                    // FS's follows the thread too: a program reloading FS finds its
                    // own TEB. Bytes 2..7 of the descriptor: the base's low three
                    // bytes, the access and flags as the ROM wrote them, the high.
                    host.writePhysical(THREAD_DESCRIPTOR + 2, new Uint8Array([
                        threadBase & 0xff, threadBase >>> 8 & 0xff, threadBase >>> 16 & 0xff,
                        0x92, 0xcf, threadBase >>> 24 & 0xff,
                    ]));
                },

                /**
                 * A context for a thread that has not run yet: the current CPU state
                 * as a template -- segments and the rest of the process environment
                 * -- positioned at its own entry point and stack, with the
                 * floating-point environment a new thread starts with.
                 *
                 * @param {Object} options
                 * @param {number} options.entry
                 * @param {number} options.stackTop
                 * @returns {any}
                 */
                newContext({ entry, stackTop }){
                    const context = captureCurrentContext();
                    freshThreadFpu(context);
                    context.eip = entry;
                    context.reg32[4] = stackTop; // ESP
                    context.reg32[5] = stackTop; // EBP
                    context.inHlt = 0;
                    return context;
                },

                instructionCount: ()=>started().instructionCount(),
                compiledModules: ()=>started().compiledModules(),
                interpretedSteps: ()=>started().interpretedSteps(),
                hostWrittenBytes: ()=>started().hostWrittenBytes(),
                /**
                 * The emulator's own zstd decoder, which a bundle read can use
                 * while the emulator is loaded: it answers synchronously, as a
                 * guest read needs, and is several times faster than this project's
                 * own. Under `cork` there is none -- the host has no such member --
                 * so the caller falls back to `modules/core/src/zstd.js`.
                 *
                 * @param {Uint8Array} packed @param {number} expectedLength
                 */
                decompressZstd: (packed, expectedLength)=>
                    started().decompressZstd(packed, expectedLength),
                /**
                 * The emulator's account of where the guest ran, by address and
                 * weighted by instructions. Kept only between start and stop, and
                 * only by a build that carries it.
                 */
                profile: {
                    /** The profiler build's counts, null without one. */
                    instructionStats: ()=>started().instructionStats(),
                    available: ()=>started().profile.available(),
                    /**
                     * @param {{ keepCode?: boolean }} [options]
                     *     `keepCode` leaves the warm code alone, which is how a
                     *     release build says where the interpreter ran: see the
                     *     cpu layer's own note on it.
                     */
                    start: options=>started().profile.start(options),
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
            const instance = current;
            if (!instance || !instance.host)
            {
                return {
                    name: 'cpu', version: '0.1.0', status: 'created',
                    metrics: instance ? { engine: instance.engine } : {},
                };
            }
            return {
                name: 'cpu',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    // Which execution engine this launch selected, so a report
                    // says what the figures below were measured on.
                    engine: instance.engine,
                    running: instance.running,
                    instructions: instance.host.instructionCount(),
                    protectedMode: instance.host.inProtectedMode(),
                    traps: instance.thunks ? instance.thunks.size : 0,
                    trapCapacity: instance.thunks ? instance.thunks.capacity : 0,
                    // How many traps the host has answered since boot, so a
                    // program stuck in a trap is visible as a count that grows
                    // with the turns.
                    trapCrossings: instance.host.trapCrossings(),
                    ports: instance.host.ports ? instance.host.ports() : null,
                    // Under cork, the last slices: where each began and ended and what
                    // it retired, so a run that makes no progress says where it sits.
                    recent: instance.host.recentSlices ? instance.host.recentSlices() : null,
                    recentStarts: instance.host.recentStarts ? instance.host.recentStarts() : null,
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
                    jit: instance.host.jitState(),
                    // Where the guest is right now. A thread that spins in guest
                    // code makes no host call, so nothing else in this report can
                    // say what it is doing; sampled repeatedly from outside, this
                    // one number names the loop.
                    eip: instance.host.eip(),
                    // Where every slice since boot has gone, by address bucket.
                    // `top` is reported by the bucket's own address rather than
                    // by rank, so a caller polling this once a second (the
                    // overlay's own pattern) can take a delta per bucket across
                    // two readings instead of per position in the list.
                    samples: {
                        slices: instance.samples.slices,
                        overflow: instance.samples.overflow,
                        top: topSamples(instance.samples, 64),
                    },
                    // The translator's own report, or null when none is attached.
                    cork: instance.cork ? instance.cork.diagnostics() : null,
                    // The differential's own account, or null when the engine is
                    // not one with a replay.
                    differential: typeof instance.host?.differentialDiagnostics === 'function'
                        ? instance.host.differentialDiagnostics()
                        : null,
                },
            };
        },

        async dispose(){
            if (current)
            {
                // The translator's own bookkeeping -- a directory store's index --
                // lands before the machine goes away, so the next run finds this
                // one's regions in it. Awaiting also keeps a put in flight from
                // rejecting after the store is gone.
                if (current.cork && typeof current.cork.flush === 'function')
                {
                    await current.cork.flush();
                }
                if (current.host)
                {
                    current.host.stop();
                }
                current.host = null;
                current.thunks = null;
                current.running = false;
                current.tableWritten = false;
                current.worstInterpreted = 0;
                current.worstInterpretedAt = 0;
                current.interpretedBefore = 0;
                current.lastFault = null;
                current.samples = createSampleTable();
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const cpuModule = createCpuModule();
