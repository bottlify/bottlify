/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier (plan step 5.2): cork's decoder of 2.1 and evaluator of
 * 2.2, run over the state block one instruction at a time. It is the tier for
 * the instruction met once -- cold code, a refused instruction, a volatile
 * page -- where translating a whole region would cost more than running it.
 *
 * The evaluator's integer set is here. The x87, MMX and SSE operations the
 * emitter has and `ir.js` lacks are the remaining work of this step; an
 * instruction with no model throws `Unsupported`, which the host answers with
 * `cpu: cork has no tier for …` and hands to the other executor, as a refused
 * instruction is handled under hybrid.
 */

import { decode } from './decode/decoder.js';
import { Fault, Unsupported, createState, evaluate } from './ir.js';
import { compileFast } from './fast.js';
import { eflagsOf } from './emit/flags.js';
import { Tables } from './runtime/layout.js';
import { PageFlag } from './runtime/pages.js';

export { Fault, Unsupported, createState };

/** Decoded runs per state, by their first address, with the bytes they were
 * decoded from. A hit is checked byte for byte against memory, so code
 * rewritten in place (by the guest or the host) is decoded again without any
 * invalidation; the check is a few byte reads where a decode builds every
 * instruction's record.
 * @type {WeakMap<object, Map<number, Run>>} */
const runsBy = new WeakMap();
// ponytail: cleared whole when full; an LRU if a title's cold set churns it.
const RUNS_CAP = 1 << 15;
/** The most instructions one run holds. */
const RUN_LENGTH = 64;
const NO_BYTES = new Uint8Array(0);

/**
 * Instructions that fall through from one to the next, decoded and compiled
 * once: the unit the interpreter looks up, checks and reports, rather than
 * one instruction at a time. A run ends after a jump, a call, a return, a
 * `hlt` and anything that traps or faults by design (`closed`); a conditional
 * branch does not end it, and a taken one leaves it midway. It grows as
 * execution first reaches its end, so what is decoded is what ran: cold code
 * runs once or twice, and decoding ahead of it was most of its cost. A
 * refusal is a run of its own with no instructions, not kept.
 *
 * @typedef {{ start: number, bytes: Uint8Array, count: number, closed: boolean,
 *     starts: number[], nexts: number[],
 *     steps: (((state: import('./ir.js').EvalState) => void) | null)[],
 *     decoded: import('./decode/decoder.js').Instruction[],
 *     refused: import('./decode/decoder.js').Refusal | null }} Run
 */

/**
 * Whether memory still holds `bytes` at `address`, read as the decoder would
 * (a fault where it would fault). A memory that knows its own layout answers
 * it without a call a byte (`blockState`'s `same`).
 *
 * @param {{ read: (address: number, size: number) => number }} memory
 * @param {number} address @param {Uint8Array} bytes
 */
function sameBytes(memory, address, bytes){
    for (let i = 0; i < bytes.length; i++)
    {
        if (memory.read(address + i, 1) !== bytes[i])
        {
            return false;
        }
    }
    return true;
}

/** @param {import('./decode/decoder.js').Instruction} instruction */
const endsRun = ({ op, faults })=>faults === 'halt' || faults === 'trap' || faults === 'invalid'
    || op === 'jmp' || op === 'call' || op === 'ret';

/**
 * Decodes the instruction at the run's end onto it, with its bytes. The first
 * instruction of a run is decoded as the processor fetches it -- a fault there
 * is the fetch's own -- and a later one only if it decodes: one that would
 * fault or be refused is left for a run of its own, reached when execution
 * gets there. A memory that cannot say when a run's own bytes are written
 * (`watch`) gets runs of one.
 *
 * @param {import('./ir.js').EvalState} state @param {Run} run
 * @returns {boolean} whether an instruction was added
 */
function extendRun(state, run){
    const { memory } = state;
    const at = run.count === 0 ? run.start : run.nexts[run.count - 1];
    /** @param {number} address */
    const read = address=>memory.read(address, 1);
    /** @type {import('./decode/decoder.js').Instruction
     *     | import('./decode/decoder.js').Refusal} */
    let decoded;
    if (run.count === 0)
    {
        decoded = decode(read, at);
    }
    else
    {
        try
        {
            decoded = decode(read, at);
        }
        catch {
            return false;
        }
    }
    if ('refused' in decoded)
    {
        if (run.count === 0)
        {
            run.refused = decoded;
        }
        return false;
    }
    const next = (at + decoded.length) >>> 0;
    run.starts.push(at);
    run.nexts.push(next);
    run.steps.push(compileFast(decoded));
    run.decoded.push(decoded);
    run.count++;
    run.closed = endsRun(decoded) || run.count >= (memory.watch === undefined ? 1 : RUN_LENGTH);
    const bytes = new Uint8Array(run.bytes.length + decoded.length);
    bytes.set(run.bytes);
    for (let i = 0; i < decoded.length; i++)
    {
        bytes[run.bytes.length + i] = memory.read(at + i, 1);
    }
    run.bytes = bytes;
    return true;
}

/**
 * @param {import('./ir.js').EvalState} state
 * @param {Map<number, Run>} cache
 * @returns {Run}
 */
function runAt(state, cache){
    const { memory, eip } = state;
    // A fetch fault is raised at the instruction being fetched.
    state.faultEip = eip;
    const hit = cache.get(eip);
    if (hit !== undefined)
    {
        try
        {
            if (memory.same !== undefined
                ? memory.same(eip, hit.bytes) : sameBytes(memory, eip, hit.bytes))
            {
                return hit;
            }
        }
        catch (e){
            // Some of the run's bytes cannot be fetched now (a page it spans
            // was freed or protected): decoded afresh, its leading
            // instructions run and the fetch faults at the one that reaches
            // the page, as the processor's own fetch would.
            if (!(e instanceof Fault))
            {
                throw e;
            }
        }
    }
    /** @type {Run} */
    const run = {
        start: eip, bytes: NO_BYTES, count: 0, closed: false, starts: [], nexts: [], steps: [],
        decoded: [], refused: null,
    };
    extendRun(state, run);
    if (run.refused === null)
    {
        if (cache.size >= RUNS_CAP)
        {
            cache.clear();
        }
        cache.set(eip, run);
    }
    return run;
}

/**
 * Runs instructions from `state.eip` until the budget is spent or the machine
 * halts, answering how many were retired.
 *
 * The host tier hands a whole slice's budget to one call. Two hooks make that
 * possible without giving up the boundary the translator needs: `shouldStop`
 * is asked before each run of instructions (`Run`) and ends the call there
 * (the host stops when the next address has an entry, or when a trap has been
 * recorded and only the host can answer it), and `onStep` is told each run's
 * start before it runs, with whether it was reached by a jump rather than by
 * falling through from the instruction before (the host counts hotness at
 * those starts only). A jump's target always starts a run, so every start a
 * jump reaches is told. `entered` says the first instruction is itself such a
 * start -- a jump's target the call begins at -- rather than a place an
 * earlier call stopped midway through a block. Both hooks are optional, so
 * the tight loop the corpus and tests use is unchanged. `force` runs the
 * first instruction whatever `shouldStop` answers, alone: the host's progress
 * guarantee, for a turn that would otherwise retire nothing. `asked` says the
 * caller has just put `shouldStop`'s question to the first start itself -- the
 * host looks for an entry there before it calls -- so the first run goes
 * ahead without it.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {number} [maxInstructions]
 * @param {{ shouldStop?: () => boolean, onStep?: (eip: number, jumped: boolean) => void,
 *     force?: boolean, entered?: boolean, asked?: boolean, jumped?: boolean }} [options]
 *     jumped: set on return, whether the address the call stopped at was reached by a
 *     jump -- a start a caller going on from there counts as `onStep` would have
 * @returns {number}
 */
export function interpret(state, maxInstructions = 1, options = {}){
    const { shouldStop, onStep, force, entered, asked } = options;
    const before = state.retired;
    const end = before + maxInstructions;
    const { memory } = state;
    // Where falling through from the last instruction lands.
    let fallthrough = entered === true ? -1 : state.eip;
    let first = force === true;
    let unasked = first || asked === true;
    let cache = runsBy.get(state);
    if (cache === undefined)
    {
        cache = new Map();
        runsBy.set(state, cache);
    }
    try
    {
        while (state.retired < end && !state.halted)
        {
            if (!unasked && shouldStop !== undefined && shouldStop())
            {
                break;
            }
            unasked = false;
            const run = runAt(state, cache);
            if (run.refused !== null)
            {
                throw new Unsupported(run.refused.opcode, run.refused.eip);
            }
            onStep?.(run.start, run.start !== fallthrough);
            const alone = first;
            first = false;
            // A store into the run's own bytes ends it after the instruction
            // that made it, so what follows is decoded again as written.
            memory.watch?.(run.start, run.start + run.bytes.length);
            const { starts, nexts, steps } = run;
            for (let i = 0; state.retired < end; i++)
            {
                if (i === run.count)
                {
                    if (alone || run.closed || !extendRun(state, run))
                    {
                        break;
                    }
                    memory.watch?.(run.start, run.start + run.bytes.length);
                }
                const next = nexts[i];
                const step = steps[i];
                // The instruction's own address, for a page fault raised from
                // inside the step after eip has moved to the next instruction.
                state.faultEip = starts[i];
                fallthrough = next;
                if (step !== null)
                {
                    // A compiled step finds eip and the count already moved, as
                    // `evaluate` moves them before its work.
                    state.eip = next;
                    state.retired++;
                    step(state);
                }
                else
                {
                    evaluate(run.decoded[i], state);
                }
                if (state.eip !== next || memory.hit === true)
                {
                    break;
                }
            }
        }
    }
    catch (e){
        // The no-tier answer carries the address of the instruction the
        // model could not run, not the one the run started at: the host
        // names what it actually met.
        if (e instanceof Unsupported && e.eip === undefined)
        {
            e.eip = state.faultEip;
        }
        throw e;
    }
    finally
    {
        memory.watch?.(0, 0);
        options.jumped = state.eip !== fallthrough;
    }
    return state.retired - before;
}

/**
 * The memory a `BlockState` runs over: cork's own RAM, tested against the
 * page flags and the code ranges in its tables. A class, so every machine's
 * memory has one shape and one set of methods: a literal of closures made
 * per machine gave each machine's its own functions, and the interpreter's
 * call sites, shared by every machine in a process, saw one more with each.
 */
class BlockMemory {
    /**
     * @param {WebAssembly.Memory} memory
     * @param {import('../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {((address: number, size: number) => void) | null} onCodeWrite
     * @param {{ faultEip: number }} owner  the state whose instruction a fault names
     */
    constructor(memory, layout, onCodeWrite, owner){
        this.view = new DataView(memory.buffer);
        this.ramBase = layout.ramBase;
        // The decoder reads code a byte at a time, so the byte path skips the
        // DataView call and its bounds check; wider accesses keep the DataView.
        this.ramBytes = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
        // The page flags as bytes: every access tests one or two, and a typed
        // array is cheaper than a DataView call.
        this.pageFlags = new Uint8Array(memory.buffer, layout.tables + Tables.PAGE_FLAGS,
            Tables.PAGE_FLAGS_SIZE);
        this.codeRanges = layout.tables + Tables.CODE_RANGES;
        this.onCodeWrite = onCodeWrite;
        this.owner = owner;
        // The bytes of the run being interpreted (`watch`): a store into them
        // sets `hit`, and the run ends after the instruction that made it.
        this.watchStart = 0;
        this.watchEnd = 0;
        this.hit = false;
    }

    /** @param {number} address @param {number} size */
    inaccessible(address, size){
        const { pageFlags } = this;
        if ((pageFlags[address >>> 12] & PageFlag.INACCESSIBLE) !== 0)
        {
            return true;
        }
        return size > 1 && (pageFlags[(address + size - 1) >>> 12] & PageFlag.INACCESSIBLE) !== 0;
    }

    /**
     * Whether the byte lies in translated code: its page flagged and its
     * granule within the page's code range, as the emitter's `codeHit` does.
     *
     * @param {number} address
     */
    codeHit(address){
        if ((this.pageFlags[address >>> 12] & PageFlag.HAS_CODE) === 0)
        {
            return false;
        }
        const range = this.codeRanges + (address >>> 12) * 2;
        const granule = (address >>> Tables.CODE_GRANULE_SHIFT)
            & (0xfff >>> Tables.CODE_GRANULE_SHIFT);
        return granule >= this.view.getUint8(range) && granule < this.view.getUint8(range + 1);
    }

    fault(){
        return new Fault(13, this.owner.faultEip);
    }

    /**
     * An access within one page tests that page's flag once; one that crosses
     * a page tests both, as `inaccessible` does.
     *
     * @param {number} address @param {number} size
     */
    read(address, size){
        if ((address & 0xfff) <= 0x1000 - size
            ? (this.pageFlags[address >>> 12] & PageFlag.INACCESSIBLE) !== 0
            : this.inaccessible(address, size))
        {
            throw this.fault();
        }
        const offset = this.ramBase + address;
        return size === 1 ? this.ramBytes[address]
            : size === 2 ? this.view.getUint16(offset, true) : this.view.getUint32(offset, true);
    }

    /** @param {number} address @param {number} size @param {number} value */
    write(address, size, value){
        const plain = (address & 0xfff) <= 0x1000 - size
            && (this.pageFlags[address >>> 12] & (PageFlag.INACCESSIBLE | PageFlag.HAS_CODE)) === 0;
        // A store within one page of plain memory -- neither inaccessible nor
        // holding translated code -- has nothing to test after its flag.
        if (!plain && this.inaccessible(address, size))
        {
            throw this.fault();
        }
        if (size === 1)
        {
            this.ramBytes[address] = value;
        }
        else if (size === 2)
        {
            this.view.setUint16(this.ramBase + address, value, true);
        }
        else
        {
            this.view.setUint32(this.ramBase + address, value, true);
        }
        if (address < this.watchEnd && address + size > this.watchStart)
        {
            this.hit = true;
        }
        if (!plain && this.onCodeWrite !== null
            && (this.codeHit(address) || (size > 1 && this.codeHit(address + size - 1))))
        {
            this.onCodeWrite(address, size);
        }
    }

    /**
     * `Memory.repeat`, as translated code moves a `rep movs` or `rep stos` in
     * bulk (`bulkString` in `emit/integer.js`): every element that lies wholly
     * on the pointers' current pages at once, when the destination's page is
     * neither inaccessible nor holding translated code, the source's can be
     * read, and a copy's destination does not lie just ahead of its source,
     * where the processor repeats the source's first elements and a memmove
     * does not.
     *
     * @param {boolean} copy @param {number} to @param {number} from
     * @param {number} size @param {number} count @param {number} value
     */
    repeat(copy, to, from, size, count, value){
        const { pageFlags, ramBytes } = this;
        let n = Math.min(count, (0x1000 - (to & 0xfff)) / size | 0);
        if (copy)
        {
            n = Math.min(n, (0x1000 - (from & 0xfff)) / size | 0);
        }
        const bytes = n * size;
        if (n === 0
            || (pageFlags[to >>> 12] & (PageFlag.INACCESSIBLE | PageFlag.HAS_CODE)) !== 0)
        {
            return 0;
        }
        if (copy)
        {
            if ((pageFlags[from >>> 12] & PageFlag.INACCESSIBLE) !== 0
                || ((to - from - 1) >>> 0) < bytes - 1)
            {
                return 0;
            }
            ramBytes.copyWithin(to, from, from + bytes);
        }
        else
        {
            const word = value >>> 0;
            const byte = word & 0xff;
            if (word === (size === 4 ? byte * 0x01010101 : size === 2 ? byte * 0x0101 : byte))
            {
                ramBytes.fill(byte, to, to + bytes);
            }
            else
            {
                for (let address = to; address < to + bytes; address += size)
                {
                    if (size === 2)
                    {
                        this.view.setUint16(this.ramBase + address, word, true);
                    }
                    else
                    {
                        this.view.setUint32(this.ramBase + address, word, true);
                    }
                }
            }
        }
        if (to < this.watchEnd && to + bytes > this.watchStart)
        {
            this.hit = true;
        }
        return n;
    }

    /**
     * The decode cache's check: whether RAM still holds `bytes` at `address`,
     * compared in place when they lie in one accessible page, read one by one
     * (faulting as a fetch would) when not.
     *
     * @param {number} address @param {Uint8Array} bytes
     */
    same(address, bytes){
        const n = bytes.length;
        if ((address & 0xfff) > 0x1000 - n
            || (this.pageFlags[address >>> 12] & PageFlag.INACCESSIBLE) !== 0)
        {
            return sameBytes(this, address, bytes);
        }
        const { ramBytes } = this;
        for (let i = 0; i < n; i++)
        {
            if (ramBytes[address + i] !== bytes[i])
            {
                return false;
            }
        }
        return true;
    }

    /** @param {number} start @param {number} end */
    watch(start, end){
        this.watchStart = start;
        this.watchEnd = end;
        this.hit = false;
    }
}

/**
 * An `EvalState` over cork's own state block (`blockState`). A class, so the
 * states of every machine in a process share one prototype and one layout of
 * fields: made as `Object.create` of a literal of accessors per machine, each
 * machine's state had a prototype of its own, and the interpreter's steps --
 * one set of functions for every machine -- read `state.eip` and the rest
 * through as many shapes as there had been machines, polymorphic from the
 * second and megamorphic from the fifth. The fields a step touches are the
 * instance's own; the rest are accessors on the prototype, since one object
 * holding both was too many accessors for V8's fast properties, and every
 * `state.retired++` and `state.eip =` was a dictionary lookup and an
 * uninlined call.
 */
class BlockState {
    /**
     * @param {WebAssembly.Memory} memory
     * @param {import('../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {((address: number, size: number) => void) | null} onCodeWrite
     * @param {(() => bigint) | undefined} rdtsc
     */
    constructor(memory, layout, onCodeWrite, rdtsc){
        const view = new DataView(memory.buffer);
        this.reg = new Uint32Array(memory.buffer, layout.regs, 8);
        // eip and the flags word are the state's own between `syncIn` and
        // `syncOut`: every step writes eip and most read and write the flags,
        // and a field is cheaper than an accessor over the block.
        this.eip = view.getUint32(layout.eip, true);
        this.eflags = view.getUint32(layout.eflags, true);
        this.memory = new BlockMemory(memory, layout, onCodeWrite, this);
        this.x87Exact = 0;
        this.x87Shadow = new BigInt64Array(8);
        this.halted = false;
        this.retired = 0;
        /** @type {number[]} */
        this.trapped = [];
        this.rdtsc = rdtsc;
        // The instruction's own address, kept by `interpret` for a fault's EIP.
        this.faultEip = 0;
        this.view = view;
        this.layout = layout;
        // The x87 registers are one f64 every sixteen bytes in the block, which
        // no typed array can stride; they are copied in and out around a run,
        // as the XMM registers are -- on the run's first use of them, and back
        // only when it used them: most runs of integer code touch neither, and
        // the copy was most of a short run's cost. The words beside them are
        // read and written directly.
        const f80Bytes = new ArrayBuffer(64);
        this.f80Values = new Float64Array(f80Bytes);
        this.f80Words = new BigInt64Array(f80Bytes);
        this.xmmWords = new Uint32Array(32);
        this.x87In = false;
        this.xmmIn = false;
    }

    loadX87(){
        if (!this.x87In)
        {
            for (let i = 0; i < 8; i++)
            {
                this.f80Values[i] = this.view.getFloat64(this.layout.x87 + i * 16, true);
            }
            this.x87In = true;
        }
    }

    loadXmm(){
        if (!this.xmmIn)
        {
            for (let word = 0; word < 32; word++)
            {
                this.xmmWords[word] = this.view.getUint32(this.layout.xmm + word * 4, true);
            }
            this.xmmIn = true;
        }
    }

    get f80(){
        this.loadX87();
        return this.f80Values;
    }

    get f80bits(){
        this.loadX87();
        return this.f80Words;
    }

    get xmm(){
        this.loadXmm();
        return this.xmmWords;
    }

    get top(){
        return this.view.getUint8(this.layout.x87Top) & 7;
    }

    set top(value){
        this.view.setUint8(this.layout.x87Top, value & 7);
    }

    get empty(){
        return this.view.getUint8(this.layout.x87Empty);
    }

    set empty(value){
        this.view.setUint8(this.layout.x87Empty, value & 0xff);
    }

    get status(){
        return this.view.getUint16(this.layout.x87Status, true);
    }

    set status(value){
        this.view.setUint16(this.layout.x87Status, value & 0xffff, true);
    }

    get control(){
        return this.view.getUint16(this.layout.x87Control, true);
    }

    set control(value){
        this.view.setUint16(this.layout.x87Control, value & 0xffff, true);
    }

    get mxcsr(){
        return this.view.getUint32(this.layout.mxcsr, true);
    }

    set mxcsr(value){
        this.view.setUint32(this.layout.mxcsr, value >>> 0, true);
    }

    get fsBase(){
        return this.layout.fsBase >= 0 ? this.view.getUint32(this.layout.fsBase, true) : 0;
    }

    set fsBase(value){
        if (this.layout.fsBase >= 0)
        {
            this.view.setUint32(this.layout.fsBase, value >>> 0, true);
        }
    }

    /** Takes the block's flags word into the state, and its x87 and XMM
     * registers into the arrays on their first use. */
    syncIn(){
        this.x87In = false;
        this.xmmIn = false;
        // Translated code may have written the registers since.
        this.x87Exact = 0;
        // The record a region left is folded into the word the steps use.
        this.eflags = eflagsOf(this.view, this.layout);
    }

    /** Writes eip, the flags word and the arrays back into the block. */
    syncOut(){
        const { view, layout } = this;
        view.setUint32(layout.eip, this.eip >>> 0, true);
        view.setUint32(layout.eflags, this.eflags >>> 0, true);
        if (this.x87In)
        {
            for (let i = 0; i < 8; i++)
            {
                view.setFloat64(layout.x87 + i * 16, this.f80Values[i], true);
            }
        }
        if (this.xmmIn)
        {
            for (let word = 0; word < 32; word++)
            {
                view.setUint32(layout.xmm + word * 4, this.xmmWords[word], true);
            }
        }
        this.x87In = false;
        this.xmmIn = false;
    }
}

/**
 * An `EvalState` whose registers, flags, eip and fsBase are cork's own state
 * block's, so a program the interpreter runs leaves the same state the
 * translator would. The memory is cork's own RAM.
 *
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout,
 *     onCodeWrite?: (address: number, size: number) => void,
 *     rdtsc?: () => bigint }} what
 *     `onCodeWrite` is called after an interpreted store lands in a page
 *     holding translated code, so the caller can invalidate the region it
 *     translated there, as a translated store's `stale` exit does.
 * @returns {import('./ir.js').EvalState & { syncIn: () => void, syncOut: () => void }}
 */
export function blockState({ memory, layout, onCodeWrite, rdtsc }){
    return new BlockState(memory, layout, onCodeWrite ?? null, rdtsc);
}
