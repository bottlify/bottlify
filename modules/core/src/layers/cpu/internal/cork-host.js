/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * The cork host: the cpu layer's host over cork's own memory, with no emulator.
 *
 * `engine: 'cork'` runs a program with nothing of the emulator loaded -- not
 * its machine, not its wasm. This host is what stands in for it: a
 * `WebAssembly.Memory` of its own, cork's own layout (a 512-byte state block,
 * the guest's RAM after it, cork's tables after that), and the translator's
 * runtime over the two. The slice loop is the translator's entry, or -- where
 * none exists yet -- the interpreter tier of 5.2, which runs cork's own decoder
 * and evaluator over the state block one instruction at a time. An instruction
 * the evaluator has no model for is the engine's no-tier answer, and a fault
 * becomes the host's fault record.
 *
 * There is no ROM. The boot ROM exists to switch the emulator from real mode
 * and set up its descriptor caches; cork's layout has no segment registers and
 * no control registers, flat 32-bit protected mode being all it translates, so
 * the host sets the registers the ROM would have left: esp at the initial
 * stack, eflags reserved-bit set, the x87 control word and the MXCSR at their
 * defaults, every x87 register empty, and eip read from the entry vector at the
 * first slice (the loader writes the entry point there after boot, the way the
 * ROM's indirect jump read it).
 *
 * Nothing here imports the cork package statically -- the layer never imports an
 * engine package, so the engine module (`createEngine`, `ownLayout`, the table
 * and page arithmetic) is handed in by `module.js`, which loaded it by URL.
 */

import { exceptionName, hostFault } from './faults.js';
import { captureBlockContext, restoreBlockContext } from './context.js';
import { createPorts } from './ports.js';

/** Register names in the state block's reg32 view, in index order. */
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
/** Long mode's sixteen, as the 64-bit block holds them. */
const REGISTERS64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10',
    'r11', 'r12', 'r13', 'r14', 'r15'];

/**
 * How far the counter runs ahead of the guest's clock inside a slice: the
 * clock's own ceiling on one credit, so the two never drift further apart.
 */
const TSC_DRIFT_MS = 16;

/** The translator's page flag that closes a page (`PageFlag.INACCESSIBLE`). */
const PAGE_INACCESSIBLE = 1;
/** cork's NO_EXECUTE: a page that reads and runs nothing. */
const PAGE_NO_EXECUTE = 16;

/** The default x87 control word: double-extended precision, round to nearest. */
const DEFAULT_CONTROL_WORD = 0x037f;
/** The default MXCSR: every SIMD exception masked. */
const DEFAULT_MXCSR = 0x1f80;
/**
 * eflags after boot: bit 1 is reserved and always set. IF stays clear although
 * a Windows thread reads it set from pushfd: the boot ROM clears it so that no
 * device interrupt ever reaches the emulator's guest (threads are switched on
 * retired instructions, not a timer), and the two engines must show a guest the
 * same flags.
 */
const DEFAULT_EFLAGS = 0x2;
/**
 * Instructions handed to the translated code at a time while a slice may end
 * early: regions chain inside the wasm, and one call ran a whole slice without
 * coming back to be asked. Not the quantum -- a slice nobody preempts is these
 * run back to back to the same total.
 */
const YIELD_CHUNK = 10_000;
/**
 * An interpreted stretch runs a hundred times slower than translated code, so a
 * quantum of it held the engine thread for tens of milliseconds while frames,
 * the translator's answers and the other threads waited. The interpreter runs
 * in chunks of this many instructions, and a slice that has interpreted ends
 * once it has taken `SLICE_MS`, as a time slice would; translated code, which
 * runs a quantum in a fraction of that, is not looked at.
 */
const INTERPRET_CHUNK = 8192;
const SLICE_MS = 8;
/** The flat 32-bit code selector the segments are implicit at. */
const FLAT_CS = 0x08;
/** #UD, the fault an instruction the processor does not know raises. */
const INVALID_OPCODE = 6;
/** #PF. */
const PAGE_FAULT = 14;
const GENERAL_PROTECTION = 13;
/** How many of those the diagnostics name. */
const UNTIERED_KEPT = 16;
/**
 * How far the JavaScript interpreter carries a process's hosts before the wasm
 * tier takes over, in their instructions (`wasmInterpreterAfter`'s default),
 * and what a jump target new to a host counts as. The tier's start -- its
 * module compiled, and the optimising compile the wasm engine gives its `run`
 * a few hundred instructions in, once a process -- costs more on one core than
 * the two to four thousand instructions a small program interprets before its
 * loops are translated; new code is what the JavaScript interpreter is slow at
 * (a decode and closures an instruction), so a loader or a table of many small
 * functions hands over within a few dozen new targets, a loop only once it has
 * run the whole stretch.
 */
const WASM_AFTER = 8192;
/**
 * The longest host write into the RAM made a dword at a time (`copyIn`): the
 * structures a call fills in, past which a byte copy is faster and has no
 * thread reading it as it is written.
 */
const WORDWISE_BYTES = 256;
const NEW_TARGET_WORK = 128;
/** The names an engine module must export for this host. */
const ENGINE_EXPORTS = Object.freeze([
    'createEngine', 'ownLayout', 'pagesFor', 'Tables', 'STATE_BLOCK_SIZE',
    'interpret', 'blockState', 'eflagsOf', 'setEflags', 'executorLayout', 'executorBytes',
    'tablesSize', 'blockFields',
    'SHARED_CODE_BYTES', 'WASM_INTERPRETER_STATICS_AT', 'WASM_INTERPRETER_STATICS',
]);

/**
 * @param {number} value
 * @param {number} [width]
 */
const hex = (value, width = 8)=>(value >>> 0).toString(16).padStart(width, '0');

/**
 * @typedef {Object} CorkHostConfig
 * @property {any} engine  The cork engine module: `{ createEngine, ownLayout,
 *     pagesFor, Tables, STATE_BLOCK_SIZE }`.
 * @property {number} memorySize   Guest RAM in bytes.
 * @property {number} trapPort
 * @property {number} entryVector  Linear address of the dword holding the entry point.
 * @property {number} [thunkBase]  Where the thunk table and its park loop begin.
 * @property {number} initialStack Initial guest ESP.
 * @property {import('../engine.js').EngineConfig} [cork]  The translator's config.
 * @property {number} [translationZone]  The bytes the translator may hold, its tables
 *     past the guest's RAM included: the runtime is given the rest (`cacheBytes`) unless
 *     its config names a figure of its own.
 * @property {number} [noExecuteBelow]  Addresses below this run nothing -- an
 *     instruction fetched there is a page fault -- whatever reads and writes
 *     they answer.
 * @property {number} [closedBelow]  Addresses below this are no-access: a fetch, a
 *           store or an interpreted read there faults. Zero, the default, closes none.
 * @property {number} [executors]  Executors the memory has room for, each a state page and
 *     tables of its own past the first's (`executorLayout`). Default 1.
 * @property {number} [executor]   Which of them this host is. Default 0, the first, whose state
 *     block is at the start of the memory.
 * @property {WebAssembly.Memory} [memory]  The memory, made by the host of another executor of
 *     the process (`wasmMemory`) -- shared, sized for `executors` -- rather than one of its own.
 * @property {{ memory: WebAssembly.Memory, guestEnd: number }} [reused]  The memory of a
 *     process that has gone, taken instead of a new one where it is the size this host would
 *     make: a finished process's memory is freed only by a garbage collection nothing prompts,
 *     and a parent starting one short-lived child after another would otherwise hold one
 *     memory per child. Below `guestEnd` the guest may have written, and that is zeroed with
 *     the engine's own pages; above it the guest's memory is as it was made.
 * @property {SharedArrayBuffer} [tsc]  The time-stamp counter every executor of the process
 *     shares (`TscWord`): the guest's clock as the process last published it, and the last
 *     count any of them read.
 * @property {{ simd: boolean, tailCalls: boolean, sharedMemory: boolean,
 *     defaultNaNNegative: boolean }} [features]  What the engine translates for in place of
 *     what it finds in this host's: the tests run here what another host's translator makes.
 * @property {{ everyMs: number, bytes: number } | false} [gcNudge]  How the threads holding
 *     the guest's memory bring JavaScriptCore's collections forward (`gc-nudge.js`), as the
 *     process settled it; an executor's worker nudges by it.
 * @property {32 | 64} [bits]  64 for a long-mode (x86-64) process: the engine's 64-bit state
 *     block, run on its long-mode interpreter, on one executor. Default 32.
 */

/**
 * The words of the shared time-stamp counter (`CorkHostConfig.tsc`), each a BigInt64.
 * The guest's clock is in microseconds, -1 until the process publishes it.
 */
export const TscWord = Object.freeze({ GUEST_US: 0, LAST: 1 });

/** @returns {SharedArrayBuffer} a shared time-stamp counter, the guest's clock not yet published */
export function createTsc(){
    const tsc = new SharedArrayBuffer(16);
    new BigInt64Array(tsc)[TscWord.GUEST_US] = -1n;
    return tsc;
}

/**
 * The rate cork's time-stamp counter advances at, in MHz, which is the speed
 * the machine reports everywhere else too -- the registry's `~MHz` and CPUID
 * leaves 0x15 and 0x16 -- because a program turns rdtsc deltas into seconds with it. A
 * machine's era is read off this figure: a program that finds 1 GHz picks the
 * settings it ships for the slowest machine it supports.
 */
export const CORK_TSC_MHZ = 3000;

/** The least a runtime is given to hold its modules in: its own `cacheBytes` 0 would be none. */
const LEAST_CACHE = 8 << 20;

/**
 * An executor's part of what its process's translators may hold of their
 * modules: each executor's runtime makes instances of its own, so the zone is
 * split, not given whole to each. One executor (a phone's) holds it all. With
 * more, the process's own executor, which runs the main thread and every
 * thread bound to the host, takes three quarters and the others share the
 * rest: a half each way had the process's own let its modules go and bring
 * them back thousands of times a run (the Doom 3 demo, four executors) while
 * the others held little. Never less than `LEAST_CACHE`, which a zone the
 * tables leave too little of goes past (the run's zones table says so).
 *
 * @param {number} bytes  the zone less the engine's tables
 * @param {number} executors
 * @param {number} executor
 */
export function cacheShare(bytes, executors, executor){
    const share = executors <= 1 ? bytes
        : executor === 0 ? bytes * 3 / 4 : bytes / 4 / (executors - 1);
    return Math.max(LEAST_CACHE, Math.floor(share));
}

/**
 * Builds the cork host over a memory of its own.
 *
 * @param {CorkHostConfig} config
 */
export function createCorkHost(config){
    const { engine, memorySize, trapPort, entryVector, initialStack, cork: corkConfig,
        closedBelow = 0, noExecuteBelow = 0, executors = 1, executor = 0, memory: given,
        reused, tsc, features, translationZone, bits = 32 } = config;
    // Long mode: the 64-bit block and the long-mode interpreter, which is all
    // the engine runs 64-bit code on so far.
    const long = bits === 64;
    if (long && (executors !== 1 || typeof engine?.interpret64 !== 'function'))
    {
        throw new Error('cpu: a 64-bit process runs on one executor of an engine with'
            + ' a long-mode interpreter');
    }
    // Where code may run from: a closed range runs nothing either.
    const runsFrom = Math.max(closedBelow, noExecuteBelow) >>> 0;
    for (const name of ENGINE_EXPORTS)
    {
        if (engine?.[name] === undefined)
        {
            throw new Error(`cpu: the cork engine module does not export ${name}`);
        }
    }
    const { createEngine, ownLayout, pagesFor, Tables, STATE_BLOCK_SIZE, interpret, blockState,
        eflagsOf, setEflags, WasmExit, executorLayout, executorBytes, tablesSize,
        blockFields, WASM_INTERPRETER_STATICS_AT, WASM_INTERPRETER_STATICS } = engine;
    if (!(executor >= 0 && executor < executors))
    {
        throw new Error(`cpu: executor ${executor} of ${executors}`);
    }
    // The host's own pacing, the config's where it names one (`EngineConfig`).
    const yieldChunk = corkConfig?.yieldChunk ?? YIELD_CHUNK;
    const interpretChunk = corkConfig?.interpretChunk ?? INTERPRET_CHUNK;
    const sliceMs = corkConfig?.sliceMs ?? SLICE_MS;
    const tscDriftMs = corkConfig?.tscDriftMs ?? TSC_DRIFT_MS;

    // The guest RAM is the whole memorySize; the tables and the state block are
    // memory of cork's own beside it, not carved out of the guest's. `own` is
    // the first executor's layout.
    // The entry hash's slots are the engine's own unless the config names a size.
    // Guest RAM from the memory's start: a Windows program maps nothing in its
    // first 64 KiB, where the state page lies instead (`ownLayout`), and RAM
    // addressed from 0 is shorter code on arm64. An engine whose layout has no
    // such choice keeps its own.
    const own = ownLayout({ ramSize: memorySize, processors: executors, ramBase: 0,
        ...(long ? { bits } : {}),
        ...(corkConfig?.hashSlots ? { hashSlots: corkConfig.hashSlots } : {}) });
    const blockSize = long ? engine.STATE_BLOCK_SIZE_64 : STATE_BLOCK_SIZE;
    // The guest's addresses the state page and the wasm interpreter's statics
    // past it hold: closed to the program for good. Its first page stays open,
    // where a read through a null pointer finds zeroes as on a page nobody
    // maps, and so does the rest of the range, as the program's.
    const enginePages = own.ramBase === 0
        ? { from: own.regs, to: own.regs + WASM_INTERPRETER_STATICS_AT + WASM_INTERPRETER_STATICS }
        : { from: 0, to: 0 };
    /** Whether the engine holds a guest address. @param {number} address */
    const engineHolds = address=>address >= enginePages.from && address < enginePages.to;
    // Every field from the start of a state block, as the block's views read
    // it: the same on every executor, whose blocks a thread's context moves
    // between (`blockLayout`).
    const inBlock = blockFields(own);
    const tables = tablesSize(own);
    // A profiling run (`blockProfile`) has the block profile past the tables,
    // and the interpreter tier in wasm its hot counts past that.
    const profileSize = import.meta.BOTTLIFY_DIAGNOSTICS !== false && corkConfig?.blockProfile
        ? Tables.BLOCK_PROFILE_SIZE : 0;
    const wasmWanted = typeof engine.createWasmInterpreter === 'function'
        && corkConfig?.wasmInterpreter !== false && !long;
    const past = tables + profileSize + (wasmWanted ? engine.WASM_INTERPRETER_AREA : 0);
    const firstPages = pagesFor(own, past);
    // Every other executor's: its state page, its tables and what lies past them.
    const executorPages = Math.ceil((executorBytes(own) - tables + past) / 65536);
    /** Where an executor's state page begins. @param {number} index */
    const executorBase = index=>(index === 0 ? own.regs
        : (firstPages + (index - 1) * executorPages) * 65536);
    const stateBase = executorBase(executor);
    const layout = executor === 0 ? own : executorLayout(own, stateBase, executor);
    const wasmArea = layout.tables + tables + profileSize;
    // Past every executor's pages, the record they keep together of who holds
    // code where and which stores reached it (`shared-code.js`).
    const sharedAt = executors > 1 ? (firstPages + (executors - 1) * executorPages) * 65536 : -1;
    const pages = firstPages + (executors - 1) * executorPages
        + (executors > 1 ? Math.ceil(engine.SHARED_CODE_BYTES / 65536) : 0);
    // Shared where the host can share it -- a page that is cross-origin
    // isolated, or node -- so another worker can read and write guest memory
    // in place; the translated code runs as fast on either.
    const shared = corkConfig?.sharedMemory !== false && typeof SharedArrayBuffer === 'function'
        && /** @type {any} */ (globalThis).crossOriginIsolated !== false;
    if (given !== undefined && given.buffer.byteLength < pages * 65536)
    {
        throw new Error(`cpu: a memory of ${given.buffer.byteLength} bytes has no room for`
            + ` ${executors} executors`);
    }
    const taken = given === undefined && reused !== undefined
        && reused.memory.buffer.byteLength === pages * 65536
        && (typeof SharedArrayBuffer === 'function'
            && reused.memory.buffer instanceof SharedArrayBuffer) === shared
        ? reused.memory : undefined;
    const memory = given ?? taken
        ?? new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
    // The memory past the guest's RAM: the engine's tables and pages for every
    // executor, which the translator's zone holds before any module of it.
    const engineBytes = memory.buffer.byteLength - own.ramBase - memorySize;
    const cacheBytes = corkConfig?.cacheBytes ?? (translationZone === undefined ? undefined
        : cacheShare(translationZone - engineBytes, executors, executor));
    if (taken !== undefined)
    {
        // A new memory is zero; this one is made so where it was used: its
        // state block and the guest's RAM up to where the guest was given
        // memory, and everything past the RAM -- the engine's tables, the
        // other executors' pages and the record they kept together.
        const bytes = new Uint8Array(memory.buffer);
        const guestEnd = Math.min(Math.max(reused?.guestEnd ?? memorySize, 0), memorySize);
        bytes.fill(0, 0, own.ramBase + guestEnd);
        bytes.fill(0, own.ramBase + memorySize);
    }

    // The memory is fixed (initial === maximum), so the buffer never detaches
    // and the views are taken once.
    const block = new Uint8Array(memory.buffer, stateBase, blockSize);
    const blockView = new DataView(memory.buffer, stateBase, blockSize);
    const reg32 = new Int32Array(memory.buffer, layout.regs, 8);
    const reg64 = long ? new BigUint64Array(memory.buffer, layout.regs, 16) : null;
    /** A general register's low dword, either mode's. @param {number} index */
    const regLow = index=>(reg64 === null ? reg32[index] >>> 0
        : Number(reg64[index] & 0xffffffffn));
    const xmm = new Uint32Array(memory.buffer, layout.xmm, long ? 64 : 32);
    const ram = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const whole = new DataView(memory.buffer);
    const wholeWords = new Int32Array(memory.buffer);
    // The process's own executor's interrupt word (`layout.interrupt`), where
    // the process has others: they store it when they need its answer, and its
    // translated code leaves at the next back edge; it reads and clears it.
    const interruptWord = own.interrupt === undefined ? -1 : own.interrupt >>> 2;
    const interruptible = executor === 0 && interruptWord >= 0;
    /**
     * Answers what the other executors stored the word for (`onInterrupt`);
     * false puts the answer off to the next back edge.
     *
     * @type {(() => boolean | void) | null}
     */
    let interruptHandler = null;
    let interrupts = 0;
    /** Whether another executor stored the word since this one last took it. */
    const interrupted = ()=>interruptible && Atomics.load(wholeWords, interruptWord) !== 0;

    /** The flags word, whole: the record a region left is folded into it first. */
    const eflagsWord = ()=>eflagsOf(blockView, inBlock) >>> 0;
    /** @param {number} address  A guest address. */
    const ramOffset = address=>layout.ramBase + address;
    /**
     * A host write that would reach the engine's pages -- the whole RAM made
     * new at once -- writes around them: the machine's state and the
     * interpreter's statics stay as they were.
     *
     * @param {number} address @param {number} length
     */
    const acrossEngine = (address, length)=>address < enginePages.to
        && address + length > enginePages.from;
    /**
     * The host's write into the RAM. A short one at an aligned address goes in
     * a dword at a time, each one store, as an x86 dword store is: the shared
     * memory's copy went a byte at a time unless both ends were 8-aligned, and
     * a pointer, count or flag the host published was read half written by a
     * thread on another executor (3.4 M of 157 M reads in a probe). A long one
     * -- a texture, a file read -- has no such reader and keeps the copy.
     *
     * @param {number} address @param {Uint8Array} bytes
     */
    const copyIn = (address, bytes)=>{
        const length = bytes.length;
        if (length > WORDWISE_BYTES || (address & 3) !== 0)
        {
            ram.set(bytes, address);
            return;
        }
        const first = ramOffset(address) >>> 2;
        let at = 0;
        for (; at + 4 <= length; at += 4)
        {
            wholeWords[first + (at >>> 2)] = bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
                | bytes[at + 3] << 24;
        }
        for (; at < length; at++)
        {
            ram[address + at] = bytes[at];
        }
    };
    /** @param {number} address @param {Uint8Array} bytes */
    const copyAround = (address, bytes)=>{
        if (!acrossEngine(address, bytes.length))
        {
            copyIn(address, bytes);
            return;
        }
        if (address < enginePages.from)
        {
            copyIn(address, bytes.subarray(0, enginePages.from - address));
        }
        if (address + bytes.length > enginePages.to)
        {
            copyIn(enginePages.to, bytes.subarray(enginePages.to - address));
        }
    };
    /** @param {number} address @param {number} value @param {number} length */
    const fillAround = (address, value, length)=>{
        if (!acrossEngine(address, length))
        {
            ram.fill(value, address, address + length);
            return;
        }
        ram.fill(value, address, Math.min(address + length, enginePages.from));
        ram.fill(value, Math.max(address, enginePages.to), address + length);
    };

    // The boot state: the registers the ROM would have left, and nothing run.
    block.fill(0);
    if (reg64 === null)
    {
        reg32[4] = initialStack | 0; // ESP
    }
    else
    {
        reg64[4] = BigInt(initialStack >>> 0);
    }
    blockView.setUint32(inBlock.eflags, DEFAULT_EFLAGS, true);
    blockView.setUint16(inBlock.x87Control, DEFAULT_CONTROL_WORD, true);
    block[inBlock.x87Empty] = 0xff; // every register empty
    blockView.setUint32(inBlock.mxcsr, DEFAULT_MXCSR, true);

    /** @type {((value: number) => void) | null} */
    let trapHandler = null;
    let trapCrossings = 0;
    /** The instructions met that neither tier carries, as they were answered. */
    /** @type {string[]} */
    const untiered = [];
    /** The last slices, newest last: where each began and ended, what it
     * retired, the traps it crossed and whether it halted -- what a run that
     * makes no progress is read by.
     * @type {{ at: number, end: number, retired: number, traps: number, halted: boolean }[]} */
    const recent = [];
    const RECENT = 16;
    // The park loop (hlt; jmp at the thunk base) is where a thread waits, not
    // a path: its starts are left out so the ring keeps how the thread got there.
    const parkBase = (config.thunkBase ?? 0x100000) >>> 0;
    /**
     * The interpreter tier in wasm (`interp-wasm.js`): the integer instruction
     * set run straight from guest memory, the JavaScript interpreter taking
     * what it leaves, once the JavaScript interpreter has carried the
     * process's first stretch (`interpretRange`). It counts hotness in the
     * same table and keeps the same ring of starts, in its area past the
     * tables, from the first instruction; `wasmInterpreter: false` runs the
     * JavaScript interpreter alone.
     *
     * @type {import('../engine.js').WasmInterpreter | null}
     */
    const wasmTier = wasmWanted
        ? engine.createWasmInterpreter({ memory, layout, area: wasmArea,
            statics: stateBase + WASM_INTERPRETER_STATICS_AT,
            hotThreshold: corkConfig?.hotThreshold ?? 2, trapPort, parkBase,
            precise: corkConfig?.precise === true, atomic: corkConfig?.atomic === true })
        : null;
    /** The last run starts the interpreter ran, a ring: the path a run took
     * into wherever it sits. The wasm tier's, when there is one. */
    const starts = wasmTier?.starts ?? new Uint32Array(256);
    let ownStartAt = 0;
    const startIndex = wasmTier ? wasmTier.startIndex : ()=>ownStartAt;
    /** @param {number} at */
    const noteStart = at=>{
        const index = startIndex();
        starts[index & 255] = at;
        if (wasmTier)
        {
            wasmTier.setStartIndex(index + 1);
        }
        else
        {
            ownStartAt = index + 1;
        }
    };
    // Instructions the wasm tier retired: with the JavaScript interpreter's own
    // count, what the feed's spacing is measured in.
    let wasmRetired = 0;
    let halted = false;
    let stopped = false;
    /**
     * Asked between regions whether to end the slice early: a thread of
     * higher priority has come due (the scheduler's `preemptionDue`). A slice
     * is guest instructions, and one of cold or heavy code ran 100 ms while a
     * sound mixer woken every 5 ms waited behind it; ending at a region
     * boundary is ending where the budget would have.
     *
     * @type {(() => boolean) | null}
     */
    let yieldCheck = null;

    // Set when the interpreter notes a hot start: the slice ends there so the
    // layer's feed forms the candidate before the next slice, instead of the
    // whole first pass running interpreted ahead of the translator.
    let feedDue = false;
    // A hot note under the frame feed: the interpreter yields so the translator
    // can run, but the slice does NOT end -- the loop below feeds and carries on
    // with what is left of the budget. A loading phase is one long frame, so a
    // frame-boundary feed alone would run the whole load interpreted.
    let translateDue = false;
    // The interpreter's count at the last in-slice feed: a feed waits for
    // FEED_MIN_STEPS interpreted instructions after it, so a loader that meets
    // a new start every few instructions does not translate on every one.
    let retiredAtFeed = 0;
    const FEED_MIN_STEPS = 2048;
    // A candidate was noted since that feed.
    let notedSinceFeed = false;
    // Read through these in a loop condition: `stopped` is set by `stop()` and
    // `halted` by a nested slice, which the static check cannot see.
    const isHalted = ()=>halted;
    const isStopped = ()=>stopped;
    // Read through a function like the two above: `countHot` sets it.
    const isFeedDue = ()=>feedDue;
    // eip is read from the entry vector at the first slice, the way the ROM's
    // indirect jump read it: the loader writes the entry point after boot.
    // Another executor's threads are placed in its block by the process: it
    // never starts from the entry vector.
    let entered = executor !== 0;
    /** @type {import('./faults.js').GuestFault | null} */
    let lastFault = null;
    /**
     * Who is offered a fault before it stops the machine: the layer, which
     * hands it to the program's own exception handlers.
     *
     * @type {((fault: import('./faults.js').GuestFault) => boolean) | null}
     */
    let faultHandler = null;
    let hostWrites = 0;
    let hostWrittenBytes = 0;
    // The counter word folded the way the layer folds it: exact as long as reads
    // come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;

    // RIP in long mode, whose code lies in the window below 4 GiB.
    const eip = long ? ()=>Number(blockView.getBigUint64(inBlock.eip, true))
        : ()=>blockView.getUint32(inBlock.eip, true) >>> 0;
    /** @param {number} value */
    const setEip = value=>{
        if (long)
        {
            blockView.setBigUint64(inBlock.eip, BigInt(value >>> 0), true);
        }
        else
        {
            blockView.setUint32(inBlock.eip, value >>> 0, true);
        }
        entered = true;
    };
    const x87Top = ()=>block[inBlock.x87Top] & 7;
    /** @param {number} index */
    const x87At = index=>inBlock.x87 + (index & 7) * 16;

    /** The trap the call channel reaches: run the handler, answer whether to leave
     * -- 1 where the handler moved EIP, 2 where the turn is to end (a stop, a halt),
     * which a region answers by going back to the loop rather than on to the
     * region found for EIP.
     * @param {number} value
     */
    const raiseTrap = value=>{
        trapCrossings++;
        const at = eip();
        if (trapHandler)
        {
            trapHandler(value >>> 0);
        }
        return halted || stopped ? 2 : eip() !== at ? 1 : 0;
    };

    /**
     * The interpreter tier (5.2): cork's own decoder and evaluator over the
     * state block, one instruction at a time. A `Fault` becomes the fault
     * record; an `Unsupported` instruction is this engine's no-tier answer.
     *
     * @type {any}
     */
    let interpreter = null;
    /**
     * The processor this executor plays while it is not its own (`playProcessor`):
     * the one `cpuid` names. Translated code leaves `cpuid` to the interpreter
     * under the shared layout, the only one a process of several executors has.
     *
     * @type {number | undefined}
     */
    let played;

    // Cork's own time-stamp counter, at CORK_TSC_MHZ, the rate CPUID's leaves
    // 0x15 and 0x16 state: ticks of the guest's clock once one is given (`useGuestClock`,
    // the clock QueryPerformanceCounter and GetTickCount read), so a program
    // that calibrates the counter against them measures that rate whatever the
    // host did meanwhile; the page's clock since the host was made until then. The
    // guest's clock moves between slices, so within one the counter goes on at
    // the page's rate from its last move, at most a credit's worth, and never
    // backward.
    //
    // Another executor's guest clock is the one the process publishes in the
    // shared counter (`tsc`), and the last count is shared too, so a thread
    // reads one counter wherever it runs, as on a machine whose cores' counters
    // are in step: counted from this worker's own page clock, a thread that ran
    // a slice here saw the time go back by however long the process had run
    // before this executor opened, and a game timing its frames by it slept
    // that long.
    const tscBase = performance.now();
    const TICKS_PER_MS = CORK_TSC_MHZ * 1000;
    const tscWords = tsc === undefined ? null : new BigInt64Array(tsc);
    /** @type {(() => number) | null} milliseconds of guest time */
    let guestClock = null;
    /** @returns {number | null} milliseconds of guest time, if any is given or published */
    const guestNow = ()=>{
        if (guestClock !== null)
        {
            return guestClock();
        }
        const us = tscWords === null ? -1n : Atomics.load(tscWords, TscWord.GUEST_US);
        return us < 0n ? null : Number(us) / 1000;
    };
    let guestMs = 0;
    let guestMovedAt = 0;
    let lastTsc = 0;
    /** @param {number} ticks @returns {bigint} the count read: past every count read before */
    const later = ticks=>{
        if (tscWords === null)
        {
            lastTsc = Math.max(lastTsc + 1, ticks);
            return BigInt(lastTsc);
        }
        const wanted = BigInt(ticks);
        let seen = Atomics.load(tscWords, TscWord.LAST);
        for (;;)
        {
            const next = wanted > seen ? wanted : seen + 1n;
            const was = Atomics.compareExchange(tscWords, TscWord.LAST, seen, next);
            if (was === seen)
            {
                return next;
            }
            seen = was;
        }
    };
    const readTsc = ()=>{
        const now = performance.now();
        let ticks = (now - tscBase) * TICKS_PER_MS;
        const ms = guestNow();
        if (ms !== null)
        {
            if (ms !== guestMs)
            {
                guestMs = ms;
                guestMovedAt = now;
            }
            ticks = (guestMs + Math.min(now - guestMovedAt, tscDriftMs)) * TICKS_PER_MS;
        }
        return later(Math.floor(ticks));
    };
    const ports = createPorts(()=>Number(readTsc()) / TICKS_PER_MS);
    // A slow slice's account of itself reads the clock around every range the
    // interpreter runs -- a tenth of a crossing's cost -- so only a run that
    // asked for the translator's timings keeps one, and a production bundle
    // has none.
    const timings = import.meta.BOTTLIFY_DIAGNOSTICS !== false && corkConfig?.timings === true;
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && timings
        ? ()=>performance.now() : ()=>0;

    const runtime = createEngine({
        memory,
        layout,
        ...(features === undefined ? {} : { features }),
        // One translation for every other executor of the process: made for
        // the shared layout, it is the same on each, so the arena and the
        // store keep it once whichever of them asked for it first. The
        // process's own keeps its own layout, the state and the tables at
        // constant addresses: under the shared one each access adds a base, a
        // load from the state block may fault and so is never dropped as dead,
        // and the base itself stays live across loops -- a called function's
        // code was a sixth larger, a seven-instruction loop kept eax on the
        // stack, and the benchmark ran 7 % slower (geometric mean, a call
        // through a table of 4096 targets 35 %). It runs the process's first
        // thread and any thread alone; what it runs elsewhere too is
        // translated twice, never once per executor.
        ...(executors > 1 && executor !== 0 && typeof engine.sharedLayout === 'function'
            ? { sharedLayout: engine.sharedLayout(own) } : {}),
        config: { ...(trapPort === undefined ? {} : { trapPort }), ...corkConfig,
            ...(cacheBytes === undefined ? {} : { cacheBytes }),
            ...(sharedAt < 0 ? {} : { sharedCode: { at: sharedAt, index: executor } }) },
        read: (/** @type {number} */ address)=>ram[address],
        // Past RAM's end `read` answers nothing, which a copy keeps as zeros.
        readBytes: (/** @type {number} */ start, /** @type {number} */ end)=>{
            const bytes = new Uint8Array(end - start);
            bytes.set(ram.subarray(Math.min(start, ram.length), Math.min(end, ram.length)));
            return bytes;
        },
        imports: {
            trap: raiseTrap,
            getEflags: eflagsWord,
            x87Read: (/** @type {number} */ index)=>
                blockView.getFloat64(x87At(index), true),
            rdtsc: readTsc,
        },
    });

    // The emulator reads every address below RAM's end, so only cork alone,
    // which no longer answers to it, closes a range: a translated read outside
    // `precise` still wraps into RAM rather than testing it.
    if (closedBelow > 0)
    {
        runtime.pages?.markRange(0, closedBelow, PAGE_INACCESSIBLE);
    }
    if (enginePages.to > enginePages.from)
    {
        runtime.pages?.markRange(enginePages.from, enginePages.to - enginePages.from,
            PAGE_INACCESSIBLE);
    }
    // And nothing below `runsFrom` runs on either interpreter: the wasm tier
    // leaves a fetch there to the host, which faults it.
    if (runsFrom > 0)
    {
        runtime.pages?.markRange(0, runsFrom, PAGE_NO_EXECUTE);
    }

    // Long mode's translator: blocks over the 64-bit block, the interpreter
    // taking what they leave (`createLongRunner`); `translate: false` keeps it
    // off, as it keeps the 32-bit one off.
    const longRunner = long && corkConfig?.translate !== false
        && typeof engine.createLongRunner === 'function' && runtime.pages
        ? engine.createLongRunner({ memory, layout, pages: runtime.pages,
            hot: corkConfig?.hotThreshold ?? 2,
            below: runsFrom })
        : null;

    /**
     * A host write over translated code drops the regions made of a byte it
     * changed (`stored`); one that writes the bytes already there drops none.
     *
     * @param {number} address
     * @param {number} length
     * @param {boolean} [guest]  the program's own store, met by an interpreter
     */
    const invalidate = (address, length, guest = false)=>{
        if (length <= 0)
        {
            return;
        }
        if (longRunner !== null)
        {
            longRunner.invalidate(address, length);
            return;
        }
        if (sharedAt >= 0)
        {
            // The process's other executors drop theirs too.
            runtime.codeWritten(address, length);
            return;
        }
        runtime.stored(address, length, guest);
    };

    // Hotness in cork mode, counted by the interpreter itself: a start run
    // `hotThreshold` times becomes a candidate, and the layer's feed forms it.
    // A translated start is never interpreted again, so the count stops there.
    // Two under cork, not the sampler's two thousand: there is no compiled
    // second executor to carry the code in the meantime, so a start costs a
    // translation on its second visit. A title's loader runs millions of
    // instructions each met once or twice, and every one met twice is a
    // candidate -- which is why the runtime drains its queue hottest first:
    // the count keeps growing while a candidate waits and is handed over at
    // every power of two, so the loop met forty thousand times is formed
    // before the code met twice, and the queue's length costs nothing but
    // memory.
    const hotThreshold = corkConfig?.hotThreshold ?? 2;
    // The counts live in a flat array rather than a map: one byte per four
    // bytes of the first sixteen megabytes of address space, wrapping there.
    // A map grew an entry for every instruction a straight-line loader ran
    // once and never again, which a real route's loading code is millions of;
    // a slot two addresses share only makes the count reach the threshold a
    // visit early, and a candidate noted for an address that is not hot is a
    // translation the runtime declines for nothing.
    const HOT_SLOTS = 1 << 22;
    const HOT_MASK = HOT_SLOTS - 1;
    const hotCounts = wasmTier?.hotCounts.length === HOT_SLOTS
        ? wasmTier.hotCounts : new Uint8Array(HOT_SLOTS);
    // Whether translated code runs the wasm tier at a miss of the entry hash
    // (`interpretWith`): from the tier's first run on this host.
    let tierInstalled = false;
    /** Instructions either interpreter has retired, the wasm tier's runs from translated code
     * among them. */
    const interpretedSoFar = ()=>(interpreter?.retired ?? 0) + wasmRetired
        + (tierInstalled && wasmTier !== null ? wasmTier.entered() : 0);
    // The JavaScript interpreter's stretch before the wasm tier (WASM_AFTER).
    // It is the process's, not the host's: the tier's start is paid once a
    // process, so every host adds what it runs to the tier's one account, and
    // a host made once the tier has started runs it from the first
    // instruction. Once the stretch is spent the tier runs every range, and
    // `wasmSwitch` ends the range it ran out in.
    const wasmAfter = corkConfig?.wasmInterpreterAfter ?? WASM_AFTER;
    const newTargetWork = corkConfig?.newTargetWork ?? NEW_TARGET_WORK;
    let wasmDue = wasmTier !== null && (wasmAfter <= 0 || wasmTier.started());
    let wasmSwitch = false;
    /** Counts one interpreted start and notes the address once it is hot.
     * @param {number} address
     */
    const countHot = address=>{
        const slot = (address >>> 2) & HOT_MASK;
        if (hotCounts[slot] === 0 && !wasmDue && wasmTier !== null)
        {
            wasmTier.stretch.work += newTargetWork;
            if (wasmTier.stretch.work >= wasmAfter)
            {
                wasmDue = true;
                wasmSwitch = true;
            }
        }
        // Saturating: past 255 a start is as hot as it gets.
        if (hotCounts[slot] < 255)
        {
            hotCounts[slot]++;
        }
        const count = hotCounts[slot];
        // Handed over at the threshold and again at every power of two after
        // it, each time with the count as its heat, so a candidate that keeps
        // running moves up the runtime's queue while it waits.
        if (count >= hotThreshold && (count & (count - 1)) === 0)
        {
            runtime.noteHot(address, x87Top(), count);
            // Under the slice feed the candidate is formed at the slice's end,
            // so leave the interpreter there rather than run the whole hot
            // body interpreted before the translator ever sees it. Under the
            // frame feed the slice does not end; the loop feeds in place.
            if (corkConfig?.feed === 'slice')
            {
                feedDue = true;
            }
            else
            {
                notedSinceFeed = true;
            }
        }
        // A candidate noted too soon after the last feed is fed once the
        // spacing allows, here at a later start: a tight loop is noted for the
        // last time on its 128th turn, and with no frame to feed it -- a
        // loader's long stretch -- it ran interpreted to its end.
        if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
        {
            translateDue = true;
        }
    };

    /** Fold the block's 32-bit counter word into the exact count. */
    const fold = ()=>{
        const word = blockView.getUint32(inBlock.counter, true) >>> 0;
        counted += (word - lastWord) >>> 0;
        lastWord = word;
    };

    /**
     * The fault record built from a `fault` exit. Cork-alone has no IDT, so
     * there is no frame the processor pushed to read: the record is the vector
     * the exit carries and the state the faulting instruction left.
     *
     * @param {number} vector
     * @returns {import('./faults.js').GuestFault}
     */
    const buildFault = vector=>{
        const at = eip();
        const name = exceptionName(vector);
        return {
            ...hostFault({
                vector,
                name,
                detail: `${name} at 0x${hex(at)}`,
                eip: at,
            }),
            cs: FLAT_CS,
            eflags: eflagsWord(),
        };
    };

    /**
     * A fault either tier raised. Offered first to the handler, with what a
     * handler needs that the emulator's ROM stub would have read off the
     * frame -- the faulting code's own stack and the two registers the stub
     * saves -- and, when the handler takes it, the machine goes on wherever
     * the handler has put eip. Either way the slice ends here, as the
     * emulator's fault stub ends it with a halt.
     *
     * @param {number} vector
     * @param {{ address: number, write: boolean } | null} [page]  for an access to a page the
     *     program cannot reach: raised as a page fault there
     */
    const takeFault = (vector, page = null)=>{
        const fault = {
            ...buildFault(vector),
            stack: regLow(4),
            eax: regLow(0),
            edx: regLow(2),
            // A page fault's error code and the address it could not reach (CR2):
            // not present, and whether the access wrote.
            ...page === null ? {} : { errorCode: page.write ? 2 : 0, address: page.address >>> 0 },
        };
        // A page the program closed itself, inside RAM: translated reads that
        // wrap into RAM would read it as zeros, so they test from now on.
        if (page !== null && page.address >>> 0 >= closedBelow && page.address >>> 0 < memorySize
            && !engineHolds(page.address >>> 0))
        {
            runtime.readsFaulted?.();
        }
        if (faultHandler?.(fault) !== true)
        {
            lastFault = fault;
        }
        halted = true;
    };

    /**
     * A fault translated code or the wasm tier left with, before the instruction:
     * a #GP there is what either raises for a page the program cannot reach,
     * whose address neither carries, so the instruction runs once more on the
     * JavaScript interpreter, which raises the same fault with the address --
     * or, if the page was opened meanwhile, simply runs it. Any other vector is
     * taken as it is.
     *
     * @param {number} vector
     */
    const takeTieredFault = vector=>{
        if (vector !== GENERAL_PROTECTION)
        {
            takeFault(vector);
            return;
        }
        interpretJs(eip(), 1, true, false, false);
    };

    // Where the last run the interpreter stepped began, so a no-tier answer
    // names the instruction it actually met rather than the address the range
    // started at.
    let lastStart = 0;
    // The interpreter's hooks, one object for every range: where translated
    // code calls into a page left to the interpreter, a range is one run long,
    // and new closures and options for each were a tenth of the crossing.
    const hooks = {
        // Answered before each run of instructions: the runs the host owns the
        // far side of. A recorded trap has to leave so the handler can move
        // eip or stop the machine; an address with an entry is translated code
        // and a different register file.
        shouldStop: ()=>interpreter.trapped.length > 0 || feedDue || translateDue || hooks.once
            || wasmSwitch || runtime.entryOf(interpreter.eip, x87Top()) >= 0,
        onStep: (/** @type {number} */ at, /** @type {boolean} */ jumped)=>{
            lastStart = at;
            // Nothing runs below `runsFrom`: a call through a null pointer
            // faults there, as it does on Windows, rather than sliding through
            // zeroes into whatever lies above.
            if (at < runsFrom)
            {
                throw Object.assign(new Error('a fetch from the null range'),
                    { vector: PAGE_FAULT, eip: at });
            }
            // Neither the park loop nor a slide through zero-filled memory
            // (add [eax], al, twice a step) is a path: the ring keeps the code
            // that led there.
            if (((at - parkBase) >>> 0) > 2 && (ram[at] !== 0 || ram[at + 1] !== 0))
            {
                noteStart(at);
            }
            if (jumped)
            {
                countHot(at);
            }
        },
        force: false,
        entered: false,
        asked: false,
        /** @type {boolean | undefined} set by the interpreter on return */
        jumped: false,
        // One run and no more: an instruction the wasm tier left, and the rest
        // of its run, before the wasm tier goes on.
        once: false,
    };
    /**
     * The interpreter tier over a whole budget: the decoder and evaluator run
     * over the block from `address` until it halts, faults, records a trap the
     * host must answer, or reaches an address the translator has an entry for
     * -- a boundary the interpreter must not cross, because translated code
     * carries its own register file. One `syncIn` and one `syncOut` bracket the
     * run rather than one per instruction, and each interpreted start is
     * counted for hotness, so a run of cold code costs a translation on its
     * second visit instead of a thousand syncs.
     *
     * A `Fault` from the evaluator builds the fault record and stops the
     * machine; an instruction the evaluator has no model for is this engine's
     * no-tier answer.
     *
     * With `force`, the first instruction runs whatever `shouldStop` answers:
     * the host forces one step when a turn would otherwise retire nothing.
     * `jumpedIn` says `address` is where a region's untranslated exit went: a
     * jump's target, counted for hotness like one the interpreter took itself.
     * Any other range starts where an earlier one stopped -- mid-block, at the
     * slice's end or at a feed -- and a start counted there became a region
     * entered in the middle of another's block, a different set each run.
     *
     * The JavaScript interpreter runs the process's first stretch
     * (`WASM_AFTER`) even where the wasm tier exists, a range cut where the
     * stretch ends.
     *
     * @param {number} address @param {number} budget @param {boolean} [force]
     * @param {boolean} [jumpedIn]
     * @returns {number}
     */
    const interpretRange = (address, budget, force = false, jumpedIn = false)=>{
        if (address < runsFrom)
        {
            setEip(address);
            takeFault(PAGE_FAULT);
            return 0;
        }
        if (wasmTier === null || force)
        {
            return interpretJs(address, budget, force, jumpedIn, false);
        }
        if (!wasmDue)
        {
            const account = wasmTier.stretch;
            const left = wasmAfter - account.work;
            if (left > 0 && !wasmTier.started())
            {
                const retired = interpretJs(address, Math.min(budget, left), false, jumpedIn,
                    false);
                account.work += retired;
                return retired;
            }
            wasmDue = true;
        }
        wasmSwitch = false;
        return interpretWasm(wasmTier, address, budget, jumpedIn);
    };

    /**
     * The interpreter tier in wasm over a range, as `interpretRange` runs one:
     * it stops where the JavaScript interpreter would -- a hot start noted, a
     * start with an entry, a trap, a halt, a fault -- and hands each
     * instruction it leaves to the JavaScript interpreter for one run of it.
     *
     * @param {NonNullable<typeof wasmTier>} tier
     * @param {number} address @param {number} budget @param {boolean} jumpedIn
     * @returns {number}
     */
    const interpretWasm = (tier, address, budget, jumpedIn)=>{
        if (!tierInstalled)
        {
            // Started: an untranslated exit whose target has no region runs
            // the tier in place from now on, and goes on at the entry it stops
            // at without coming back here.
            tierInstalled = true;
            runtime.interpretWith?.(tier.entry(), tier.entered);
        }
        blockView.setUint32(inBlock.eip, address >>> 0, true);
        lastStart = address;
        if (jumpedIn)
        {
            countHot(address);
        }
        let retired = 0;
        let tierRetired = 0;
        // The first instruction runs whatever is due, as the JavaScript
        // interpreter's first run does: the jump that brought the range here
        // may have made its start hot and the feed due, and a range that
        // retired nothing would be a forced step.
        let first = true;
        try
        {
            while (retired < budget && (first || (!feedDue && !translateDue)))
            {
                const left = budget - retired;
                // A candidate is waiting: back after the feed's spacing, to feed it.
                const code = tier.run(first && (feedDue || translateDue) ? 1
                    : notedSinceFeed ? Math.min(left, FEED_MIN_STEPS) : left);
                first = false;
                const ran = tier.retired();
                retired += ran;
                tierRetired += ran;
                wasmRetired += ran;
                const at = eip();
                if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
                {
                    translateDue = true;
                }
                if (code === WasmExit.BUDGET || code === WasmExit.CODE_WRITE)
                {
                    if (code === WasmExit.CODE_WRITE)
                    {
                        invalidate(tier.exitValue(), tier.exitSize(), true);
                    }
                    continue;
                }
                if (code === WasmExit.HOT || code === WasmExit.ENTRY)
                {
                    if (code === WasmExit.HOT)
                    {
                        runtime.noteHot(at, x87Top(), tier.exitValue());
                        if (corkConfig?.feed === 'slice')
                        {
                            feedDue = true;
                        }
                        else
                        {
                            notedSinceFeed = true;
                        }
                    }
                    if (runtime.entryOf(at, x87Top()) >= 0)
                    {
                        break;
                    }
                    continue;
                }
                if (code === WasmExit.TRAP)
                {
                    // After the port write, as the JavaScript interpreter raises it.
                    raiseTrap(tier.exitValue());
                    break;
                }
                if (code === WasmExit.HALT)
                {
                    halted = true;
                    break;
                }
                if (code === WasmExit.FAULT)
                {
                    takeTieredFault(tier.exitValue());
                    break;
                }
                retired += interpretJs(at, left, false, false, true);
                if (halted || stopped || runtime.entryOf(eip(), x87Top()) >= 0)
                {
                    break;
                }
                // The run ended at a jump's target, which the JavaScript interpreter
                // counts when it goes on there: counted here, where the wasm tier does.
                if (hooks.jumped === true)
                {
                    noteStart(eip());
                    countHot(eip());
                }
            }
        }
        finally
        {
            // The wasm tier's instructions count in the block's word as the
            // JavaScript interpreter's do, a range that dies on a no-tier
            // instruction included.
            if (tierRetired > 0)
            {
                const word = blockView.getUint32(inBlock.counter, true);
                blockView.setUint32(inBlock.counter, (word + tierRetired) >>> 0, true);
            }
        }
        return retired;
    };

    /**
     * The JavaScript interpreter over a range; with `once`, one run of it.
     *
     * @param {number} address @param {number} budget @param {boolean} force
     * @param {boolean} jumpedIn @param {boolean} once
     * @returns {number}
     */
    const interpretJs = (address, budget, force, jumpedIn, once)=>{
        if (long)
        {
            return interpretLong(address, budget, force);
        }
        interpreter ??= blockState({
            memory,
            layout,
            rdtsc: readTsc,
            atomic: corkConfig?.atomic === true,
            ...(trapPort === undefined ? {} : { ports: { ...ports, trapPort } }),
            // An interpreted store into a page a region was translated on
            // invalidates it, as a translated store's `stale` exit does.
            onCodeWrite: (/** @type {number} */ at, /** @type {number} */ size)=>{
                invalidate(at, size, true);
            },
        });
        const state = interpreter;
        state.syncIn();
        state.eip = address;
        state.processor = played;
        // A `hlt` on an earlier run left the block's halted flag set; a slice
        // the machine is awake for clears it, as the host's own flag is.
        state.halted = false;
        const before = state.retired;
        lastStart = address;
        /** @type {unknown} */
        let thrown = null;
        try
        {
            hooks.force = force;
            hooks.entered = jumpedIn;
            hooks.once = false;
            // The slice loop calls with no entry at the address and no feed
            // due, so only a trap still recorded -- one a fault cut the last
            // range short of raising -- leaves the first start's question open.
            hooks.asked = state.trapped.length === 0;
            if (once)
            {
                hooks.asked = true;
                hooks.once = true;
            }
            interpret(state, budget, hooks);
        }
        catch (e){
            const fault = /** @type {{ vector?: number, eip?: number, op?: string }} */ (e);
            if (typeof fault.vector === 'number' || typeof fault.op === 'string')
            {
                state.eip = fault.eip ?? lastStart;
            }
            thrown = e;
        }
        return settle(state, state.retired - before, thrown);
    };

    /**
     * The long-mode interpreter over a range, as `interpretJs` runs the 32-bit
     * one: no translator to stop for and no hotness to count, nothing below
     * `runsFrom` fetched, a trap answered once the run ends.
     *
     * @param {number} address @param {number} budget @param {boolean} force
     * @returns {number}
     */
    const interpretLong = (address, budget, force)=>{
        interpreter ??= engine.blockState64({
            memory,
            layout,
            rdtsc: readTsc,
            ...(trapPort === undefined ? {} : { ports: { ...ports, trapPort } }),
            onCodeWrite: (/** @type {number} */ at, /** @type {number} */ size)=>{
                invalidate(at, size, true);
            },
        });
        const state = interpreter;
        state.syncIn();
        state.rip = BigInt(address >>> 0);
        state.processor = played;
        state.halted = false;
        const before = state.retired;
        lastStart = address;
        /** @type {unknown} */
        let thrown = null;
        try
        {
            const onStep = (/** @type {number} */ at)=>{
                lastStart = at;
                if (at < runsFrom)
                {
                    throw Object.assign(new Error('a fetch from the null range'),
                        { vector: PAGE_FAULT, eip: at });
                }
                if (((at - parkBase) >>> 0) > 2)
                {
                    noteStart(at);
                }
            };
            if (longRunner !== null)
            {
                longRunner.run(state, budget, { onStep });
            }
            else
            {
                engine.interpret64(state, budget,
                    { force, shouldStop: ()=>state.trapped.length > 0, onStep });
            }
        }
        catch (e){
            const fault = /** @type {{ vector?: number, eip?: number, op?: string }} */ (e);
            if (typeof fault.vector === 'number' || typeof fault.op === 'string')
            {
                state.rip = BigInt(fault.eip ?? lastStart);
            }
            thrown = e;
        }
        return settle(state, state.retired - before, thrown);
    };

    /**
     * What either JavaScript interpreter's range leaves: the state written
     * back, its count in the block's word, a fault or a no-tier instruction
     * taken, the traps it recorded raised.
     *
     * @param {any} state @param {number} retired @param {unknown} thrown
     * @returns {number}
     */
    const settle = (state, retired, thrown)=>{
        state.syncOut();
        // The interpreter's instructions count in the block's own word, so the
        // layer's instruction count and the translated share are over the whole
        // run rather than only over what the translator ran.
        if (retired > 0)
        {
            const word = blockView.getUint32(inBlock.counter, true);
            blockView.setUint32(inBlock.counter, (word + retired) >>> 0, true);
        }
        if (thrown !== null)
        {
            const fault = /** @type {{ vector?: number, eip?: number, op?: string,
                address?: number, write?: boolean }} */ (thrown);
            if (typeof fault.vector === 'number')
            {
                // An access to a page the program cannot reach is the page fault
                // Windows raises, with the address its handler commits.
                if (typeof fault.address === 'number')
                {
                    takeFault(PAGE_FAULT, { address: fault.address, write: fault.write === true });
                }
                else
                {
                    takeFault(fault.vector);
                }
                return retired;
            }
            if (typeof fault.op === 'string')
            {
                // An instruction neither tier carries is answered as a
                // processor answers one it does not know: an invalid-opcode
                // fault the program's own handlers can take. Kept in the
                // diagnostics, where it once stopped the whole engine.
                const at = eip();
                if (untiered.length < UNTIERED_KEPT)
                {
                    untiered.push(`0x${hex(ram[at] ?? 0, 2)} (${fault.op}) at 0x${hex(at)}`);
                }
                takeFault(INVALID_OPCODE);
                return retired;
            }
            throw thrown;
        }
        if (state.trapped.length > 0)
        {
            for (const value of state.trapped.splice(0))
            {
                raiseTrap(value);
            }
        }
        if (state.halted)
        {
            halted = true;
        }
        return retired;
    };

    /**
     * Runs at most `maxInstructions` and answers how many were retired.
     *
     * While the guest stands at an address the translator has an entry for, the
     * translator runs it with what remains of the budget; otherwise the
     * interpreter runs the budget's worth of cold code in one call (5.2) until
     * it meets translated code, a trap or a stop. A `fault` exit builds the
     * fault record and stops the machine; a `halt` puts the processor where a
     * `hlt` would; a `trap` exit re-looks-up wherever the handler left eip.
     *
     * @param {number} maxInstructions
     * @returns {number}
     */
    const runSlice = maxInstructions=>{
        const sliceAt = clock();
        const wallAt = performance.now();
        if (sharedAt >= 0)
        {
            // What the process's other executors wrote over code meanwhile.
            runtime.takeCodeWrites();
        }
        stopped = false;
        feedDue = false;
        // A slice is the clock's tick. On the emulator a `hlt` holds the
        // processor until its timer interrupt, whose handler in the ROM only
        // returns, so the guest goes on at the instruction after the `hlt`
        // when the layer next runs it; this host has no timer, so being asked
        // to run is the tick, and a halt ends a slice, never the machine. A
        // fault's halt ends the same way: the layer has read the record and
        // decided where to run.
        halted = false;
        if (!entered)
        {
            setEip(whole.getUint32(ramOffset(entryVector), true));
        }
        let remaining = maxInstructions;
        let ran = 0;
        const startedAt = eip();
        const trapsBefore = trapCrossings;
        // What the slice spent on the interpreter, for a slow slice's account of
        // itself: the instructions it took and the time they cost.
        let interpreted = 0;
        let interpretMs = 0;
        // And on forming regions, which the call below does before it hands
        // the batch to the worker.
        let formMs = 0;
        // The last region left through an untranslated exit: `eip` is a jump's target.
        let jumpedIn = false;
        // An ask the handler put off: the guest runs on to its next back edge first.
        let putOff = false;
        while (remaining > 0 && !isHalted() && !isStopped() && !isFeedDue())
        {
            if (!putOff && interrupted())
            {
                // Cleared before it is answered: a store after the answer
                // looked is the next one's.
                Atomics.store(wholeWords, interruptWord, 0);
                interrupts++;
                if (interruptHandler?.() === false)
                {
                    // Not answered here (the thread is inside a routine whose
                    // lock the answer may wait for): stored again, so the
                    // guest leaves at its next back edge and is asked again.
                    Atomics.store(wholeWords, interruptWord, 0x7fffffff);
                    putOff = true;
                }
                continue;
            }
            putOff = false;
            if (yieldCheck !== null && ran > 0 && yieldCheck())
            {
                break;
            }
            if (translateDue)
            {
                // Form what the interpreter noted and carry on with the rest
                // of the budget: the slice's count is unchanged, so a loader
                // that never presents a frame still translates.
                translateDue = false;
                notedSinceFeed = false;
                retiredAtFeed = interpretedSoFar();
                const formAt = clock();
                runtime.translatePending().catch(()=>{});
                formMs += clock() - formAt;
            }
            const at = eip();
            const entry = runtime.entryOf(at, x87Top());
            if (entry >= 0)
            {
                const exit = runtime.run(entry,
                    yieldCheck === null ? remaining : Math.min(remaining, yieldChunk));
                jumpedIn = exit.kind === 'untranslated';
                remaining -= exit.retired;
                ran += exit.retired;
                if (exit.kind === 'interpreted' && wasmTier !== null)
                {
                    // A miss ran the wasm tier in place, which stopped short of
                    // an entry: what it stopped for, answered as for a run of it
                    // here (`interpretWasm`); an instruction it leaves, the budget
                    // or an entry at another top go round the loop.
                    const code = exit.vector;
                    if (code === WasmExit.HALT)
                    {
                        halted = true;
                        break;
                    }
                    if (code === WasmExit.FAULT)
                    {
                        takeTieredFault(wasmTier.exitValue());
                        break;
                    }
                    if (code === WasmExit.HOT)
                    {
                        runtime.noteHot(eip(), x87Top(), wasmTier.exitValue());
                        if (corkConfig?.feed === 'slice')
                        {
                            feedDue = true;
                        }
                        else
                        {
                            notedSinceFeed = true;
                        }
                    }
                    else if (code === WasmExit.CODE_WRITE)
                    {
                        invalidate(wasmTier.exitValue(), wasmTier.exitSize(), true);
                    }
                    else if (code === WasmExit.TRAP)
                    {
                        raiseTrap(wasmTier.exitValue());
                    }
                    if (notedSinceFeed && interpretedSoFar() - retiredAtFeed >= FEED_MIN_STEPS)
                    {
                        translateDue = true;
                    }
                }
                if (exit.kind === 'halt')
                {
                    halted = true;
                    break;
                }
                if (exit.kind === 'fault')
                {
                    takeTieredFault(exit.vector);
                    break;
                }
                if (exit.kind === 'trap')
                {
                    // A port write the region could not answer itself (x87
                    // held in its locals, or no trap import): it left past the
                    // write, and the handler runs here with the value it wrote.
                    raiseTrap(reg32[0]);
                    continue;
                }
                if (exit.kind === 'budget')
                {
                    if (remaining > 0 && interrupted())
                    {
                        // Left at a back edge for the word, not the budget:
                        // answered above, and the slice goes on.
                        continue;
                    }
                    break;
                }
                if (exit.retired === 0 && eip() === at)
                {
                    // The region at this (address, top) ran nothing -- it is
                    // compiled for another top, or leaves at its own entry.
                    // Force one interpreted instruction so the turn moves
                    // rather than spinning on the same entry.
                    const forced = interpretRange(at, remaining, true);
                    runtime.forcedStep();
                    remaining -= forced;
                    ran += forced;
                    if (forced === 0 && eip() === at)
                    {
                        break;
                    }
                }
                continue;
            }
            const interpretAt = clock();
            const stepped = interpretRange(at, Math.min(remaining, interpretChunk), false,
                jumpedIn);
            interpretMs += clock() - interpretAt;
            interpreted += stepped;
            jumpedIn = false;
            remaining -= stepped;
            ran += stepped;
            if (stepped === 0 && eip() === at)
            {
                // A budget of zero, or a first instruction that retired
                // nothing: force one instruction rather than spinning on it.
                const forced = interpretRange(at, remaining, true);
                runtime.forcedStep();
                remaining -= forced;
                ran += forced;
                if (forced === 0 && eip() === at)
                {
                    break;
                }
            }
            if (performance.now() - wallAt >= sliceMs)
            {
                break;
            }
        }
        fold();
        recent.push({ at: startedAt, end: eip(), retired: ran, traps: trapCrossings - trapsBefore,
            halted });
        // A slice is a few milliseconds; one of twenty holds a timer's thread,
        // and says what it spent them on.
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && timings)
        {
            runtime.noteStall?.(`slice i${interpreted}/${Math.round(interpretMs)}ms`
                + ` f${Math.round(formMs)}ms t${ran - interpreted} h${trapCrossings - trapsBefore}`,
            sliceAt, 20);
        }
        if (recent.length > RECENT)
        {
            recent.shift();
        }
        return ran;
    };

    /** Takes the exact-quadword marks (`x87Exact`) off registers the host wrote. @param {number} mask */
    const dropExact = mask=>{
        if (layout.x87Exact !== undefined && layout.x87Exact >= 0)
        {
            block[inBlock.x87Exact] &= ~mask;
        }
    };

    const fpu = {
        /** @param {number} value */
        setResult(value){
            const top = (block[inBlock.x87Top] - 1) & 7;
            const empty = block[inBlock.x87Empty];
            const held = (empty >>> top & 1) === 0;
            block[inBlock.x87Top] = top;
            block[inBlock.x87Empty] = empty & ~(1 << top);
            if (held)
            {
                const status = blockView.getUint16(inBlock.x87Status, true);
                blockView.setUint16(inBlock.x87Status, status | 0x201, true);
            }
            blockView.setFloat64(x87At(top), held ? -Infinity : value, true);
            dropExact(1 << top);
        },
        /** @param {number} index */
        get(index){
            return blockView.getFloat64(x87At(block[inBlock.x87Top] + index), true);
        },
        pop(){
            const top = block[inBlock.x87Top];
            block[inBlock.x87Empty] |= 1 << top;
            block[inBlock.x87Top] = (top + 1) & 7;
        },
        depth(){
            const empty = block[inBlock.x87Empty];
            let held = 0;
            for (let index = 0; index < 8; index++)
            {
                held += (empty >>> index & 1) === 0 ? 1 : 0;
            }
            return held;
        },
        controlWord: ()=>blockView.getUint16(inBlock.x87Control, true),
    };

    /** @type {Record<string, any>} */
    const host = {
        engine: ()=>'cork',
        /** The translator's runtime, for the layer's sampler and diagnostics. */
        cork: ()=>runtime,
        /** The memory's bytes past the guest's RAM: the engine's, every executor's. */
        engineBytes: ()=>engineBytes,
        /** What the translator was given to hold its modules in, if anything. */
        cacheBytes: ()=>cacheBytes ?? null,
        corkDiagnostics: ()=>({
            ...runtime.diagnostics(),
            ...wasmTier === null ? {} : { interpretedRelaxedReads: wasmTier.relaxedReads() },
            ...untiered.length === 0 ? {} : { untiered: [...untiered] },
        }),

        /** Lets the machine run: slices until it halts or is stopped. */
        run(){
            stopped = false;
            while (!isHalted() && !isStopped())
            {
                const before = eip();
                const stepped = runSlice(1 << 20);
                if (feedDue)
                {
                    // A hot start was noted: form it before the next slice so
                    // the hot body is not interpreted whole ahead of it.
                    runtime.translatePending().catch(()=>{});
                }
                if (stepped === 0 && eip() === before && !feedDue)
                {
                    break;
                }
            }
        },
        stop(){
            stopped = true;
            // Where the others interrupt this one, the stop takes the same
            // road: the slice ends at its next back edge, not at its next
            // region's end.
            if (interruptible)
            {
                Atomics.store(wholeWords, interruptWord, 0x7fffffff);
            }
        },
        /** Whether something asked the turn to end since the slice began (`stop`). */
        stopRequested: ()=>stopped,
        /** @param {boolean} value */
        setStopRequested(value){
            stopped = value;
        },
        /** Where executor `index`'s state page begins in the memory. */
        executorBase,
        /** @param {(() => boolean) | null} check */
        setYieldCheck(check){
            yieldCheck = check;
        },
        /**
         * Whether this executor's translated code leaves at a back edge when
         * another stores its interrupt word: the process's own, with others.
         */
        interruptible,
        /**
         * What this executor runs, inside a slice, when another stored the word
         * (`interruptProcess`); the slice goes on after. A handler that answers
         * false has it asked again at the guest's next back edge.
         *
         * @param {(() => boolean | void) | null} handler
         */
        onInterrupt(handler){
            interruptHandler = handler;
        },
        /**
         * Asks the process's own executor for its answer before its slice ends:
         * stored after the ask is said, so the answer finds it.
         */
        interruptProcess(){
            if (interruptWord >= 0)
            {
                Atomics.store(wholeWords, interruptWord, 0x7fffffff);
            }
        },
        /** The slices the word interrupted. */
        interrupts: ()=>interrupts,
        runSlice,

        /** One byte of guest memory, for the runtime's decoder. @param {number} address */
        readByte: address=>ram[address],
        /** Cork's own memory. */
        wasmMemory: ()=>memory,
        /** The eager flags word. */
        getEflags: eflagsWord,
        /** The x87 stack's top, for the runtime's entry lookup. */
        x87Top,
        /** Cork's own layout; the reserve is not carved from the guest's RAM. */
        stateLayout: ()=>layout,
        /**
         * The processor this executor plays from its next instruction (the
         * kernel's trade), the one `cpuid` names; undefined, its own.
         *
         * @param {number | undefined} processor
         */
        playProcessor(processor){
            played = processor;
        },
        romBase: -1,
        romSize: 0,

        halt(){
            halted = true;
        },
        halted: ()=>halted,
        haltedFlag: ()=>(halted ? 1 : 0),
        /** @param {number} value */
        setHaltedFlag(value){
            halted = value !== 0;
        },
        wake(){
            halted = false;
        },
        /** Cork is always flat 32-bit protected mode: CR0 reads PE set.
         * @param {number} index
         */
        controlRegister: index=>(index === 0 ? 1 : 0),

        /** @param {(value: number) => void} handler */
        onTrap(handler){
            trapHandler = handler;
        },
        raiseTrap,

        /** @param {number} address @param {number} length @returns {Uint8Array} */
        readPhysical: (address, length)=>ram.subarray(address, address + length),
        /** @param {number} address */
        readU32: address=>((address & 3) === 0 ? wholeWords[ramOffset(address) >>> 2] >>> 0
            : whole.getUint32(ramOffset(address), true)),
        /**
         * Dwords, signed, into an array: a host call's stack words in one call.
         *
         * @param {number} address @param {number} count @param {number[]} into @param {number} at
         */
        readU32sInto: (address, count, into, at)=>{
            const from = ramOffset(address);
            for (let word = 0; word < count; word++)
            {
                into[at + word] = whole.getInt32(from + word * 4, true);
            }
        },
        /** @param {number} address */
        readF32: address=>whole.getFloat32(ramOffset(address), true),

        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            copyAround(address, bytes);
            invalidate(address, bytes.length);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeData: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            copyAround(address, bytes);
            invalidate(address, bytes.length);
        },
        /** @param {number} address @param {number} value @param {number} length */
        fillData: (address, value, length)=>{
            hostWrites++;
            hostWrittenBytes += length;
            fillAround(address, value, length);
            invalidate(address, length);
        },

        /** @param {string} name @returns {number} */
        readReg32(name){
            if (name === 'eip')
            {
                return eip();
            }
            if (name === 'eflags')
            {
                return eflagsWord();
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            return regLow(index);
        },
        /** @param {string} name @param {number} value */
        writeReg32(name, value){
            if (name === 'eip')
            {
                setEip(value);
                return;
            }
            if (name === 'eflags')
            {
                setEflags(blockView, inBlock, value);
                return;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            if (reg64 !== null)
            {
                // A dword write, which in long mode clears the upper half.
                reg64[index] = BigInt(value >>> 0);
                return;
            }
            reg32[index] = value | 0;
        },
        /** The register width: 64 for a long-mode process. */
        bits: ()=>bits,
        /**
         * A long-mode register whole, by its name (rax..r15, rip).
         *
         * @param {string} name @returns {bigint}
         */
        readReg64(name){
            if (name === 'rip')
            {
                return BigInt(eip());
            }
            const index = REGISTERS64.indexOf(name);
            if (reg64 === null || index === -1)
            {
                throw new Error(`Unknown register "${name}"${reg64 === null ? ' (32-bit)' : ''}`);
            }
            return reg64[index];
        },
        /** @param {string} name @param {bigint} value */
        writeReg64(name, value){
            if (name === 'rip')
            {
                setEip(Number(BigInt.asUintN(32, value)));
                return;
            }
            const index = REGISTERS64.indexOf(name);
            if (reg64 === null || index === -1)
            {
                throw new Error(`Unknown register "${name}"${reg64 === null ? ' (32-bit)' : ''}`);
            }
            reg64[index] = BigInt.asUintN(64, value);
        },

        /**
         * The general registers in place, for the bridge's crossing; none in long
         * mode, whose registers are quadwords (`readReg64`).
         *
         * @returns {Int32Array | null}
         */
        registerFile: ()=>(long ? null : reg32),
        /** @param {number} base @param {number} size */
        noteStack: (base, size)=>runtime.noteStack(base, size),
        /**
         * @param {number} address @param {number} length
         * @returns {number[] | null}
         */
        takeWrites: (address, length)=>runtime.takeWrites?.(address, length) ?? null,
        /** @param {number} address @param {number} length */
        markWritten: (address, length)=>runtime.markWritten?.(address, length),
        /**
         * Opens or closes pages to the program, as a reservation's commit and
         * VirtualProtect do: a closed one faults any access, with its address.
         * Not with `checkReads: false`, where translated reads never test -- a
         * translated read would wrap into RAM where the interpreter faults, the
         * same instruction answering two ways for the whole run; left unset,
         * the first fault on such a page has reads tested from then on
         * (`takeFault`). Never below `closedBelow`, in the engine's own pages
         * or past RAM, which stay closed. Answers whether it did.
         *
         * @param {number} address @param {number} length @param {boolean} open
         */
        pageAccess: (address, length, open)=>{
            if (corkConfig?.checkReads === false || !runtime.pages)
            {
                return false;
            }
            const start = Math.max(address >>> 0, closedBelow);
            const end = Math.min((address >>> 0) + (length >>> 0), memorySize);
            // Either side of the engine's pages.
            for (const [from, to] of [[start, Math.min(end, enginePages.from)],
                [Math.max(start, enginePages.to), end]])
            {
                if (to <= from)
                {
                    continue;
                }
                if (open)
                {
                    runtime.pages.clearRange(from, to - from, PAGE_INACCESSIBLE);
                }
                else
                {
                    runtime.pages.markRange(from, to - from, PAGE_INACCESSIBLE);
                }
            }
            return true;
        },
        /** The guest's RAM in place, byte 0 at address 0. @returns {Uint8Array} */
        ramView: ()=>ram,
        /** The state block, for the block-based context capture and the tests. */
        block: ()=>block,
        blockLayout: ()=>inBlock,
        /** The host-built fault record, or null. */
        fault: ()=>lastFault,
        /**
         * Offers each fault to `handler` before recording it: one it answers
         * true for is the handler's, and eip is wherever the handler left it.
         *
         * @param {(fault: import('./faults.js').GuestFault) => boolean} handler
         */
        onFault(handler){
            faultHandler = handler;
        },
        /**
         * A fault another executor of the process took, offered to this one's handler
         * with that executor's state in this one's block: whether the handler claimed it.
         *
         * @param {any} fault
         */
        offerFault: fault=>faultHandler?.(fault) === true,
        clearFault(){
            lastFault = null;
        },
        fpu: ()=>fpu,
        cpu(){
            throw new Error('cpu: cork has no emulator CPU object');
        },

        /** One XMM register's four lanes as u32 bit patterns. @param {number} index */
        readXmm: index=>Uint32Array.from(xmm.subarray(index * 4, index * 4 + 4)),
        /** @param {number} index @param {Uint32Array} words */
        writeXmm(index, words){
            xmm.set(Uint32Array.from(words, word=>word >>> 0), index * 4);
        },
        readMxcsr: ()=>blockView.getUint32(inBlock.mxcsr, true) >>> 0,
        /** @param {number} value */
        writeMxcsr(value){
            blockView.setUint32(inBlock.mxcsr, value >>> 0, true);
        },
        x87State(){
            const registers = new Float64Array(8);
            const raw = new Uint8Array(128);
            for (let index = 0; index < 8; index++)
            {
                const at = x87At(index);
                registers[index] = blockView.getFloat64(at, true);
                raw.set(block.subarray(at, at + 16), index * 16);
            }
            const top = x87Top();
            return {
                top,
                empty: block[inBlock.x87Empty],
                control: blockView.getUint16(inBlock.x87Control, true),
                status: (blockView.getUint16(inBlock.x87Status, true) & ~0x3800
                    | top << 11) & 0xffff,
                registers,
                raw,
            };
        },
        /**
         * @param {{ top: number, empty: number, control: number, status: number,
         *     raw: Uint8Array }} state
         */
        restoreX87State(state){
            block.set(state.raw, inBlock.x87);
            dropExact(0xff);
            block[inBlock.x87Top] = state.top & 7;
            block[inBlock.x87Empty] = state.empty & 0xff;
            blockView.setUint16(inBlock.x87Control, state.control, true);
            blockView.setUint16(inBlock.x87Status, state.status & ~0x3800, true);
        },

        /** @returns {number} instructions retired since boot */
        instructionCount(){
            fold();
            return counted;
        },
        inProtectedMode: ()=>true,
        eip,
        trapCrossings: ()=>trapCrossings,
        /** The I/O ports the program touched other than the trap port. */
        ports: ports.diagnostics,
        /** The last thirty-two interpreted run starts (a jump's target, or where
         * straight-line code resumed) with their first bytes, oldest first, two
         * per string. */
        recentStarts: ()=>{
            const out = [];
            for (let i = 224; i < 256; i += 2)
            {
                const parts = [];
                for (let k = 0; k < 2; k++)
                {
                    const at = starts[(startIndex() + i + k) & 255] >>> 0;
                    let bytes = '';
                    for (let n = 0; n < 8; n++)
                    {
                        bytes += hex(ram[at + n] ?? 0, 2);
                    }
                    parts.push(`${hex(at)}:${bytes}`);
                }
                out.push(parts.join(' '));
            }
            return out;
        },
        /** The last slices as short strings, newest last. */
        recentSlices: ()=>recent.map(r=>`${hex(r.at)}->${hex(r.end)} r${r.retired} t${r.traps}`
            + (r.halted ? ' H' : '')),
        hostWrites: ()=>hostWrites,
        hostWrittenBytes: ()=>hostWrittenBytes,
        // Cork has no emulator JIT; the translator's own figures are in
        // corkDiagnostics(). -1 tells the layer's frame counter to skip the
        // emulator's JIT columns rather than read fields off a number.
        jitState: ()=>-1,
        jitCacheSize: ()=>0,
        compiledModules: ()=>runtime.counters().modules,
        interpretedSteps: ()=>0,
        /** The instructions the interpreter tier in wasm retired, for a gate that judges it. */
        wasmRetired: ()=>wasmRetired,
        instructionStats: ()=>null,
        profile: {
            available: ()=>false,
            start: ()=>false,
            stop(){},
            read: ()=>null,
        },
    };

    /**
     * Runs the time-stamp counter on the guest's clock from here on.
     *
     * @param {() => number} readMs  milliseconds of guest time
     */
    host.useGuestClock = readMs=>{
        guestClock = readMs;
        host.publishGuestClock();
    };
    /** Writes the guest's clock where the process's other executors read it, if they do. */
    host.publishGuestClock = ()=>{
        if (tscWords !== null && guestClock !== null)
        {
            Atomics.store(tscWords, TscWord.GUEST_US, BigInt(Math.round(guestClock() * 1000)));
        }
    };
    host.captureContext = (/** @type {any} */ into)=>captureBlockContext(host, into);
    host.restoreContext = (/** @type {any} */ context)=>{
        restoreBlockContext(host, context);
        entered = true;
    };
    return host;
}
