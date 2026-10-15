/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The CPU context: everything a thread owns while it is running.
 *
 * Guest threads share one register file, so every scrap of state below has to
 * move with the thread. Omitting any of it does not fault -- it silently hands
 * one thread another thread's arithmetic, which is the most expensive class of
 * bug this project has (master plan §12.1).
 *
 * This lives in the cpu layer rather than the kernel because it is shaped by
 * the executor's own representation. The kernel decides *when* to switch; what
 * a CPU context *is* belongs here, behind an opaque record.
 *
 * Cork alone keeps the whole register file in one 512-byte state block, so its
 * record is a copy of that block plus the halted flag. The emulator's record
 * stays beside it for the emulator a caller brings.
 *
 * Every field was located and round-tripped against v86 before being listed.
 * Two of them are the traps:
 *
 *   - Arithmetic flags are lazy. The raw `flags` word is missing OF, SF, AF and
 *     PF while `flags_changed` is non-zero -- measured, not theorised: after an
 *     overflowing add the raw word read 0x2 where the materialised value was
 *     0x896. All five lazy fields move together, which is bit-exact and needs no
 *     call into wasm.
 *   - `fpu_stack_ptr` and `fpu_stack_empty` are two single bytes that decide
 *     what the eight x87 registers *mean*. `fpu_stack_empty` is the tag word;
 *     there is no other. Any MMX instruction zeroes both, because MMX registers
 *     are the same storage. Restoring the 32 register words without them yields
 *     a wrong number with no fault at all.
 */

/** Index of FS in the segment tables; its base is the thread's TEB. */
export const SEGMENT_FS = 4;

/** @param {Int32Array | Uint32Array | Uint16Array | Uint8Array} view */
const copy = view=>Array.from(view);

/**
 * Captures the running thread's context.
 *
 * @param {any} cpu  The emulator's CPU object.
 * @returns {any} an opaque context record
 */
export function captureContext(cpu){
    return {
        reg32: copy(cpu.reg32),
        eip: cpu.instruction_pointer[0],
        previousIp: cpu.previous_ip[0],

        sreg: copy(cpu.sreg),
        segmentOffsets: copy(cpu.segment_offsets),
        segmentIsNull: copy(cpu.segment_is_null),
        segmentLimits: copy(cpu.segment_limits),
        segmentAccessBytes: copy(cpu.segment_access_bytes),

        // All five, together: see the note above on lazy flags.
        flags: cpu.flags[0],
        flagsChanged: cpu.flags_changed[0],
        lastOp1: cpu.last_op1[0],
        lastResult: cpu.last_result[0],
        lastOpSize: cpu.last_op_size[0],

        fpuSt: copy(cpu.fpu_st),
        fpuStackPtr: cpu.fpu_stack_ptr[0],
        fpuStackEmpty: cpu.fpu_stack_empty[0],
        fpuControlWord: cpu.fpu_control_word[0],
        fpuStatusWord: cpu.fpu_status_word[0],
        fpuOpcode: cpu.fpu_opcode[0],
        fpuIp: cpu.fpu_ip[0],
        fpuIpSelector: cpu.fpu_ip_selector[0],
        fpuDp: cpu.fpu_dp[0],
        fpuDpSelector: cpu.fpu_dp_selector[0],

        regXmm: copy(cpu.reg_xmm32s),
        mxcsr: cpu.mxcsr[0],

        // A thread parked on `hlt` is halted; without this it resumes running.
        inHlt: cpu.in_hlt[0],
    };
}

/**
 * Restores a captured context.
 *
 * No guest instruction runs during a restore, so the writes are independent and
 * their order does not matter. What matters is that all of them happen.
 *
 * @param {any} cpu
 * @param {any} context
 */
export function restoreContext(cpu, context){
    cpu.reg32.set(context.reg32);
    cpu.instruction_pointer[0] = context.eip;
    cpu.previous_ip[0] = context.previousIp;

    cpu.sreg.set(context.sreg);
    cpu.segment_offsets.set(context.segmentOffsets);
    cpu.segment_is_null.set(context.segmentIsNull);
    cpu.segment_limits.set(context.segmentLimits);
    cpu.segment_access_bytes.set(context.segmentAccessBytes);

    cpu.flags[0] = context.flags;
    cpu.flags_changed[0] = context.flagsChanged;
    cpu.last_op1[0] = context.lastOp1;
    cpu.last_result[0] = context.lastResult;
    cpu.last_op_size[0] = context.lastOpSize;

    cpu.fpu_st.set(context.fpuSt);
    cpu.fpu_stack_ptr[0] = context.fpuStackPtr;
    cpu.fpu_stack_empty[0] = context.fpuStackEmpty;
    // Not a plain field write: the emulator's fast arithmetic path reads its own
    // rounding-precision byte, derived from the control word by this export, not
    // the control word itself -- a direct write here would leave that byte at
    // whatever the previous thread's own fldcw last set it to.
    cpu.wm.exports.set_control_word(context.fpuControlWord);
    cpu.fpu_status_word[0] = context.fpuStatusWord;
    cpu.fpu_opcode[0] = context.fpuOpcode;
    cpu.fpu_ip[0] = context.fpuIp;
    cpu.fpu_ip_selector[0] = context.fpuIpSelector;
    cpu.fpu_dp[0] = context.fpuDp;
    cpu.fpu_dp_selector[0] = context.fpuDpSelector;

    cpu.reg_xmm32s.set(context.regXmm);
    cpu.mxcsr[0] = context.mxcsr;

    cpu.in_hlt[0] = context.inHlt;
}

/**
 * A cork-alone context: the whole state block, plus the fields the cpu module
 * mutates on a saved context before restoring it.
 *
 * @typedef {Object} BlockContext
 * @property {Uint8Array} block
 * @property {number[]} reg32
 * @property {number} eip
 * @property {number} previousIp
 * @property {number} inHlt
 * @property {number} fsBase
 * @property {import('../engine.js').StateLayout} layout
 */

/**
 * Views over a host's state block, made once for each block: a typed array or
 * a view made at every switch was a fifth of a thread switch's cost.
 *
 * @type {WeakMap<Uint8Array, { view: DataView, words: Int32Array }>}
 */
const blockViews = new WeakMap();

/** @param {Uint8Array} block  a state block, 4-aligned */
function viewsOf(block){
    let views = blockViews.get(block);
    if (views === undefined)
    {
        views = { view: new DataView(block.buffer, block.byteOffset, block.byteLength),
            words: new Int32Array(block.buffer, block.byteOffset, block.byteLength >> 2) };
        blockViews.set(block, views);
    }
    return views;
}

/**
 * Captures the running cork thread's context.
 *
 * The block is every register, the flags, x87, XMM and the thread's FS base,
 * so the record is a copy of it. The retired-instruction word inside the block
 * is the machine's rather than the thread's; a restore leaves the live word
 * where it is, so a switch cannot make the global count go backward or count
 * one instruction range twice.
 *
 * `into`, the thread's own last record, is written over rather than a new one
 * made: a record is the thread's alone, and an array buffer of the block's size
 * cost 3.4 us to make in node 22 -- most of a switch between two threads.
 *
 * @param {any} host  A cork host.
 * @param {BlockContext} [into]
 * @returns {BlockContext}
 */
export function captureBlockContext(host, into){
    const layout = host.blockLayout();
    const source = /** @type {Uint8Array} */ (host.block());
    const { view, words } = viewsOf(source);
    const context = into !== undefined && into.layout === layout
        && into.block?.length === source.length && Array.isArray(into.reg32)
        ? into
        : { block: new Uint8Array(source.length), reg32: new Array(8).fill(0), eip: 0,
            previousIp: 0, inHlt: 0, fsBase: 0, layout };
    context.block.set(source);
    const registers = layout.regs >> 2;
    for (let index = 0; index < 8; index++)
    {
        context.reg32[index] = words[registers + index];
    }
    context.eip = view.getUint32(layout.eip, true) >>> 0;
    context.previousIp = layout.previousIp >= 0 ? view.getUint32(layout.previousIp, true) >>> 0 : 0;
    context.inHlt = host.haltedFlag();
    context.fsBase = layout.fsBase >= 0 ? view.getUint32(layout.fsBase, true) >>> 0 : 0;
    return context;
}

/**
 * Restores a captured cork context.
 *
 * @param {any} host
 * @param {BlockContext} context
 */
export function restoreBlockContext(host, context){
    const layout = context.layout;
    const block = /** @type {Uint8Array} */ (host.block());
    const { view, words } = viewsOf(block);
    const counter = layout.counter >= 0 ? view.getUint32(layout.counter, true) >>> 0 : 0;
    block.set(context.block);
    const registers = layout.regs >> 2;
    for (let index = 0; index < 8; index++)
    {
        words[registers + index] = context.reg32[index] | 0;
    }
    view.setUint32(layout.eip, context.eip >>> 0, true);
    if (layout.previousIp >= 0)
    {
        view.setUint32(layout.previousIp, context.previousIp >>> 0, true);
    }
    if (layout.fsBase >= 0)
    {
        view.setUint32(layout.fsBase, context.fsBase >>> 0, true);
    }
    if (layout.counter >= 0)
    {
        view.setUint32(layout.counter, counter, true);
    }
    host.setHaltedFlag(context.inHlt);
}

/**
 * The x87 control word Windows starts every thread with: every exception
 * masked, double precision, round to nearest -- not the processor's reset
 * value (0x37f, extended precision), and not its creator's.
 */
export const THREAD_CONTROL_WORD = 0x027f;
/** The MXCSR a thread starts with: every SIMD exception masked, no FTZ or DAZ. */
export const THREAD_MXCSR = 0x1f80;

/**
 * Gives a context the floating-point environment a new thread starts with.
 *
 * A thread is made from its creator's context as a template (segments, the
 * process environment), but Windows starts each one with a fresh x87 and SSE
 * state: a precision a thread set with `_controlfp`, a flush-to-zero mode in its
 * MXCSR, or values left on its x87 stack are its own and do not pass to the
 * threads it creates.
 *
 * @param {any} context  Either record: the emulator's fields or cork's block.
 */
export function freshThreadFpu(context){
    if (context.block instanceof Uint8Array)
    {
        const { block, layout } = /** @type {BlockContext} */ (context);
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        view.setUint16(layout.x87Control, THREAD_CONTROL_WORD, true);
        view.setUint16(layout.x87Status, 0, true);
        block[layout.x87Top] = 0;
        block[layout.x87Empty] = 0xff;
        if (layout.x87Exact !== undefined && layout.x87Exact >= 0)
        {
            block[layout.x87Exact] = 0;
        }
        block.fill(0, layout.xmm, layout.xmm + 8 * 16);
        view.setUint32(layout.mxcsr, THREAD_MXCSR, true);
        return;
    }
    context.fpuSt.fill(0);
    context.fpuStackPtr = 0;
    context.fpuStackEmpty = 0xff;
    context.fpuControlWord = THREAD_CONTROL_WORD;
    context.fpuStatusWord = 0;
    context.fpuOpcode = 0;
    context.fpuIp = 0;
    context.fpuIpSelector = 0;
    context.fpuDp = 0;
    context.fpuDpSelector = 0;
    context.regXmm.fill(0);
    context.mxcsr = THREAD_MXCSR;
}

/**
 * The TEB base the thread runs on. Kept next to the context because moving it
 * is part of switching threads, not a duty of whoever calls the switch (§12.5).
 *
 * @param {any} context
 * @param {number} tebAddress
 */
export function setThreadBase(context, tebAddress){
    if (context.block !== undefined)
    {
        context.fsBase = tebAddress >>> 0;
        return;
    }
    context.segmentOffsets[SEGMENT_FS] = tebAddress;
}

/**
 * Sets a saved context's flags word, whole: the arithmetic state kept lazily
 * beside it -- cork's record, the emulator's operands -- is dropped, since the
 * word now says everything. For a thread sent into code with the flags it is
 * to start with: an exception handler, or where a handler's context continues.
 *
 * @param {any} context  Either record: the emulator's fields or cork's block.
 * @param {number} value
 */
export function setContextEflags(context, value){
    if (context.block instanceof Uint8Array)
    {
        const { block, layout } = /** @type {BlockContext} */ (context);
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        view.setUint32(layout.eflags, value >>> 0, true);
        if ((layout.flagRecord ?? -1) >= 0)
        {
            view.setUint32(/** @type {number} */ (layout.flagRecord), 0, true);
        }
        return;
    }
    context.flags = value | 0;
    context.flagsChanged = 0;
}

/**
 * Reports which fields differ, for tests and for diagnosing a switch that lost
 * something. Empty means the two contexts are identical.
 *
 * @param {any} a
 * @param {any} b
 * @returns {string[]}
 */
export function diffContexts(a, b){
    /** @type {string[]} */
    const differing = [];
    for (const key of Object.keys(a))
    {
        const left = a[key];
        const right = b[key];
        const same = Array.isArray(left)
            ? left.length === right.length && left.every((value, i)=>value === right[i])
            : left === right;
        if (!same)
        {
            differing.push(key);
        }
    }
    return differing;
}
