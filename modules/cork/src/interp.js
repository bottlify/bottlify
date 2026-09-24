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

/** Decoded instructions per state, by address, with the bytes they were decoded
 * from. A hit is checked byte for byte against memory, so code rewritten in
 * place (by the guest or the host) is decoded again without any invalidation;
 * the check is a few byte reads where a decode builds the whole record.
 * The entry keeps the instruction's compiled step too (`compileFast`), null for
 * one `evaluate` runs.
 * @type {WeakMap<object, Map<number, CachedStep>>} */
const decodedBy = new WeakMap();
// ponytail: cleared whole when full; an LRU if a title's cold set churns it.
const DECODED_CAP = 1 << 16;
const NO_BYTES = new Uint8Array(0);

/**
 * An instruction's entry: where it starts and where the next one does, and its
 * compiled step. A refusal is an entry of the same shape with no bytes, not
 * kept.
 *
 * @typedef {{ decoded: import('./decode/decoder.js').Instruction
 *         | import('./decode/decoder.js').Refusal,
 *     bytes: Uint8Array, start: number, next: number,
 *     step: ((state: import('./ir.js').EvalState) => void) | null }} CachedStep
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

/**
 * @param {import('./ir.js').EvalState} state
 * @param {Map<number, CachedStep>} cache
 * @returns {CachedStep}
 */
function decodeCached(state, cache){
    const { memory, eip } = state;
    const hit = cache.get(eip);
    if (hit !== undefined && (memory.same !== undefined
        ? memory.same(eip, hit.bytes) : sameBytes(memory, eip, hit.bytes)))
    {
        return hit;
    }
    const decoded = decode(address=>memory.read(address, 1), eip);
    if ('refused' in decoded)
    {
        return { decoded, bytes: NO_BYTES, start: eip, next: 0, step: null };
    }
    {
        if (cache.size >= DECODED_CAP)
        {
            cache.clear();
        }
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < bytes.length; i++)
        {
            bytes[i] = memory.read(eip + i, 1);
        }
        const entry = {
            decoded, bytes, start: eip, next: (eip + decoded.length) >>> 0,
            step: compileFast(decoded),
        };
        cache.set(eip, entry);
        return entry;
    }
}

/**
 * Runs instructions from `state.eip` until the budget is spent or the machine
 * halts, answering how many were retired.
 *
 * The host tier hands a whole slice's budget to one call. Two hooks make that
 * possible without giving up the boundary the translator needs: `shouldStop`
 * is asked before each instruction and ends the run there (the host stops when
 * the next address has an entry, or when a trap has been recorded and only the
 * host can answer it), and `onStep` is told each instruction's start before it
 * runs, with whether it was reached by a jump rather than by falling through
 * from the instruction before (the host counts hotness at those starts only).
 * `entered` says the first instruction is itself such a start -- a jump's
 * target the run begins at -- rather than a place an earlier run stopped
 * midway through a block. Both hooks are optional, so the tight
 * one-instruction loop the corpus and tests use is unchanged. `force` runs the
 * first instruction whatever `shouldStop` answers: the host's progress
 * guarantee, for a turn that would otherwise retire nothing.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {number} [maxInstructions]
 * @param {{ shouldStop?: () => boolean, onStep?: (eip: number, jumped: boolean) => void,
 *     force?: boolean, entered?: boolean }} [options]
 * @returns {number}
 */
export function interpret(state, maxInstructions = 1, options = {}){
    const { shouldStop, onStep, force, entered } = options;
    const before = state.retired;
    // Where falling through from the last instruction lands.
    let fallthrough = entered === true ? -1 : state.eip;
    let first = force === true;
    let cache = decodedBy.get(state);
    if (cache === undefined)
    {
        cache = new Map();
        decodedBy.set(state, cache);
    }
    while (state.retired - before < maxInstructions && !state.halted)
    {
        if (!first && shouldStop !== undefined && shouldStop())
        {
            break;
        }
        first = false;
        // Every entry has the one shape, and the decoded record (whose shape
        // varies with the instruction) is not touched on a compiled step.
        const { decoded, start, next, step } = decodeCached(state, cache);
        if (step === null && 'refused' in decoded)
        {
            throw new Unsupported(decoded.opcode, decoded.eip);
        }
        // The instruction's own address, for a page fault raised from inside
        // `evaluate` after it has moved eip to the next instruction.
        state.faultEip = start;
        onStep?.(start, start !== fallthrough);
        fallthrough = next;
        try
        {
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
                evaluate(/** @type {import('./decode/decoder.js').Instruction} */ (decoded), state);
            }
        }
        catch (e){
            // The no-tier answer carries the address of the instruction the
            // model could not run, not the one the run started at: the host
            // names what it actually met.
            if (e instanceof Unsupported && e.eip === undefined)
            {
                e.eip = start;
            }
            throw e;
        }
    }
    return state.retired - before;
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
    const view = new DataView(memory.buffer);
    // The decoder reads code a byte at a time, so the byte path skips the
    // DataView call and its bounds check; wider accesses keep the DataView.
    const ramBytes = new Uint8Array(memory.buffer, layout.ramBase, layout.ramSize);
    const reg = new Uint32Array(memory.buffer, layout.regs, 8);
    // Every step writes eip and most read and write eflags: a word array is
    // cheaper than a DataView call where the block keeps them aligned.
    const words = new Uint32Array(memory.buffer, 0, memory.buffer.byteLength >>> 2);
    const eipWord = layout.eip % 4 === 0 ? layout.eip >>> 2 : -1;
    const eflagsWord = layout.eflags % 4 === 0 ? layout.eflags >>> 2 : -1;
    // The page flags as bytes: every access tests one or two, and a typed array
    // is cheaper than a DataView call.
    const pageFlags = new Uint8Array(memory.buffer, layout.tables + Tables.PAGE_FLAGS,
        Tables.PAGE_FLAGS_SIZE);
    const flagAt = (/** @type {number} */ address)=>pageFlags[address >>> 12];
    /** @param {number} address @param {number} size */
    const inaccessible = (address, size)=>{
        if ((flagAt(address) & PageFlag.INACCESSIBLE) !== 0)
        {
            return true;
        }
        return size > 1 && (flagAt(address + size - 1) & PageFlag.INACCESSIBLE) !== 0;
    };
    const at = layout.tables + Tables.CODE_RANGES;
    const granuleShift = Tables.CODE_GRANULE_SHIFT;
    const granule = (/** @type {number} */ address)=>
        (address >>> granuleShift) & (0xfff >>> granuleShift);
    /** Whether the byte lies in translated code: its page flagged and its
     * granule within the page's code range, as the emitter's `codeHit` does.
     * @param {number} address
     */
    const codeHit = address=>{
        if ((flagAt(address) & PageFlag.HAS_CODE) === 0)
        {
            return false;
        }
        const range = at + (address >>> 12) * 2;
        return granule(address) >= view.getUint8(range)
            && granule(address) < view.getUint8(range + 1);
    };
    const fault = ()=>new Fault(13, state.faultEip);
    // An access within one page tests that page's flag once; one that crosses
    // a page tests both, as `inaccessible` does.
    /** @param {number} address @param {number} size */
    const read = (address, size)=>{
        if ((address & 0xfff) <= 0x1000 - size
            ? (pageFlags[address >>> 12] & PageFlag.INACCESSIBLE) !== 0
            : inaccessible(address, size))
        {
            throw fault();
        }
        const offset = layout.ramBase + address;
        return size === 1 ? ramBytes[address]
            : size === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
    };
    /** @param {number} address @param {number} size @param {number} value */
    const write = (address, size, value)=>{
        // A store within one page of plain memory -- neither inaccessible nor
        // holding translated code -- has nothing to test after its flag.
        if ((address & 0xfff) <= 0x1000 - size
            && (pageFlags[address >>> 12] & (PageFlag.INACCESSIBLE | PageFlag.HAS_CODE)) === 0)
        {
            if (size === 1)
            {
                ramBytes[address] = value;
            }
            else if (size === 2)
            {
                view.setUint16(layout.ramBase + address, value, true);
            }
            else
            {
                view.setUint32(layout.ramBase + address, value, true);
            }
            return;
        }
        if (inaccessible(address, size))
        {
            throw fault();
        }
        const offset = layout.ramBase + address;
        if (size === 1)
        {
            ramBytes[address] = value;
        }
        else if (size === 2)
        {
            view.setUint16(offset, value, true);
        }
        else
        {
            view.setUint32(offset, value, true);
        }
        if ((codeHit(address) || (size > 1 && codeHit(address + size - 1)))
            && onCodeWrite !== undefined)
        {
            onCodeWrite(address, size);
        }
    };
    // The x87 registers are one f64 every sixteen bytes in the block, which no
    // typed array can stride; they are copied in and out around a run, as the
    // XMM registers are -- on the run's first use of them, and back only when
    // it used them: most runs of integer code touch neither, and the copy was
    // most of a short run's cost. The words beside them are read and written
    // directly.
    const f80Bytes = new ArrayBuffer(64);
    const f80 = new Float64Array(f80Bytes);
    const f80bits = new BigInt64Array(f80Bytes);
    const xmm = new Uint32Array(32);
    let x87In = false;
    let xmmIn = false;
    const loadX87 = ()=>{
        if (!x87In)
        {
            for (let i = 0; i < 8; i++)
            {
                f80[i] = view.getFloat64(layout.x87 + i * 16, true);
            }
            x87In = true;
        }
    };
    const loadXmm = ()=>{
        if (!xmmIn)
        {
            for (let word = 0; word < 32; word++)
            {
                xmm[word] = view.getUint32(layout.xmm + word * 4, true);
            }
            xmmIn = true;
        }
    };
    /** The decode cache's check: whether RAM still holds `bytes` at `address`,
     * compared in place when they lie in one accessible page, read one by one
     * (faulting as a fetch would) when not.
     * @param {number} address @param {Uint8Array} bytes */
    const same = (address, bytes)=>{
        const n = bytes.length;
        if ((address & 0xfff) > 0x1000 - n
            || (pageFlags[address >>> 12] & PageFlag.INACCESSIBLE) !== 0)
        {
            return sameBytes({ read }, address, bytes);
        }
        for (let i = 0; i < n; i++)
        {
            if (ramBytes[address + i] !== bytes[i])
            {
                return false;
            }
        }
        return true;
    };
    // The accessors live on a prototype and the fields a step touches on the
    // object itself: one literal holding both is too many accessors for V8's
    // fast properties, and every `state.retired++` and `state.eip =` was a
    // dictionary lookup and an uninlined call.
    const accessors = {
        get f80(){
            loadX87();
            return f80;
        },
        get f80bits(){
            loadX87();
            return f80bits;
        },
        get xmm(){
            loadXmm();
            return xmm;
        },
        get top(){
            return view.getUint8(layout.x87Top) & 7;
        },
        set top(value){
            view.setUint8(layout.x87Top, value & 7);
        },
        get empty(){
            return view.getUint8(layout.x87Empty);
        },
        set empty(value){
            view.setUint8(layout.x87Empty, value & 0xff);
        },
        get status(){
            return view.getUint16(layout.x87Status, true);
        },
        set status(value){
            view.setUint16(layout.x87Status, value & 0xffff, true);
        },
        get control(){
            return view.getUint16(layout.x87Control, true);
        },
        set control(value){
            view.setUint16(layout.x87Control, value & 0xffff, true);
        },
        get mxcsr(){
            return view.getUint32(layout.mxcsr, true);
        },
        set mxcsr(value){
            view.setUint32(layout.mxcsr, value >>> 0, true);
        },
        get eip(){
            return eipWord >= 0 ? words[eipWord] : view.getUint32(layout.eip, true);
        },
        set eip(value){
            if (eipWord >= 0)
            {
                words[eipWord] = value;
            }
            else
            {
                view.setUint32(layout.eip, value >>> 0, true);
            }
        },
        get eflags(){
            return eflagsWord >= 0 ? words[eflagsWord] : view.getUint32(layout.eflags, true);
        },
        set eflags(value){
            if (eflagsWord >= 0)
            {
                words[eflagsWord] = value;
            }
            else
            {
                view.setUint32(layout.eflags, value >>> 0, true);
            }
        },
        get fsBase(){
            return layout.fsBase >= 0 ? view.getUint32(layout.fsBase, true) : 0;
        },
        set fsBase(value){
            if (layout.fsBase >= 0)
            {
                view.setUint32(layout.fsBase, value >>> 0, true);
            }
        },
        /** Takes the block's x87 and XMM registers into the arrays. */
        syncIn(){
            x87In = false;
            xmmIn = false;
            // The record a region left is folded into the word the steps use.
            eflagsOf(view, layout);
        },
        /** Writes the arrays back into the block. */
        syncOut(){
            if (x87In)
            {
                for (let i = 0; i < 8; i++)
                {
                    view.setFloat64(layout.x87 + i * 16, f80[i], true);
                }
            }
            if (xmmIn)
            {
                for (let word = 0; word < 32; word++)
                {
                    view.setUint32(layout.xmm + word * 4, xmm[word], true);
                }
            }
            x87In = false;
            xmmIn = false;
        },
    };
    const state = /** @type {import('./ir.js').EvalState & typeof accessors} */ (
        Object.create(accessors));
    state.reg = reg;
    state.memory = { read, write, same };
    state.halted = false;
    state.retired = 0;
    state.trapped = [];
    state.rdtsc = rdtsc;
    // The instruction's own address, kept by `interpret` for a fault's EIP.
    state.faultEip = 0;
    return state;
}
