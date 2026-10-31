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
 * the engine's own representation. The kernel decides *when* to switch; what
 * a CPU context *is* belongs here, behind an opaque record.
 *
 * The engine keeps the whole register file in one state block -- the general
 * registers, the flags word and the arithmetic record a region left beside it,
 * the x87 stack with its top and empty mask, the vector registers, the thread
 * block's base -- so a record is a copy of that block plus the halted flag.
 * The x87 top and empty mask are two bytes that decide what the eight
 * registers *mean*: restoring the registers without them yields a wrong number
 * with no fault at all, and the block carries them with the rest.
 */

/**
 * A thread's context: the whole state block, plus the fields the cpu module
 * mutates on a saved context before restoring it.
 *
 * @typedef {Object} BlockContext
 * @property {Uint8Array} block
 * @property {number[]} reg32
 * @property {number} eip
 * @property {number} previousIp
 * @property {number} inHlt
 * @property {number} fsBase
 * @property {number} [gsBase]  A long-mode thread's: its TEB, which GS addresses.
 * @property {import('../engine.js').StateLayout} layout
 *
 * In long mode `reg32` holds each of the first eight registers' low dwords and
 * `eip` RIP's: a restore writes them into the low halves and leaves the upper
 * ones as the block has them, so a resume that moves the stack pointer or the
 * accumulator keeps every quadword the thread holds. Every address is below
 * 4 GiB, so the upper half of RSP and RIP is zero.
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
 * Captures the running thread's context.
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
            previousIp: 0, inHlt: 0, fsBase: 0, gsBase: 0, layout };
    context.block.set(source);
    const registers = layout.regs >> 2;
    // A long-mode register is two words, the low one first.
    const stride = layout.bits === 64 ? 2 : 1;
    for (let index = 0; index < 8; index++)
    {
        context.reg32[index] = words[registers + index * stride];
    }
    context.eip = view.getUint32(layout.eip, true) >>> 0;
    if (layout.bits === 64)
    {
        context.gsBase = Number(view.getBigUint64(layout.gsBase, true));
    }
    context.previousIp = layout.previousIp >= 0 ? view.getUint32(layout.previousIp, true) >>> 0 : 0;
    context.inHlt = host.haltedFlag();
    context.fsBase = layout.fsBase >= 0 ? view.getUint32(layout.fsBase, true) >>> 0 : 0;
    return context;
}

/**
 * Restores a captured context.
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
    const stride = layout.bits === 64 ? 2 : 1;
    for (let index = 0; index < 8; index++)
    {
        words[registers + index * stride] = context.reg32[index] | 0;
    }
    if (layout.bits === 64)
    {
        view.setBigUint64(layout.gsBase, BigInt((context.gsBase ?? 0) >>> 0), true);
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
 * @param {BlockContext} context
 */
export function freshThreadFpu(context){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    view.setUint16(layout.x87Control, THREAD_CONTROL_WORD, true);
    view.setUint16(layout.x87Status, 0, true);
    block[layout.x87Top] = 0;
    block[layout.x87Empty] = 0xff;
    if (layout.x87Exact !== undefined && layout.x87Exact >= 0)
    {
        block[layout.x87Exact] = 0;
    }
    block.fill(0, layout.xmm, layout.xmm + (layout.bits === 64 ? 16 : 8) * 16);
    view.setUint32(layout.mxcsr, THREAD_MXCSR, true);
}

/**
 * The TEB base the thread runs on. Kept next to the context because moving it
 * is part of switching threads, not a duty of whoever calls the switch (§12.5).
 *
 * @param {BlockContext} context
 * @param {number} tebAddress
 */
export function setThreadBase(context, tebAddress){
    // Long mode reaches the TEB through GS; FS has no base there.
    if (context.layout.bits === 64)
    {
        context.gsBase = tebAddress >>> 0;
        return;
    }
    context.fsBase = tebAddress >>> 0;
}

/**
 * Clears a long-mode context's general registers, whole: a new thread's
 * template is its creator's state, and the dword view a context is moved with
 * leaves the upper halves as they were. Nothing for a 32-bit context, whose
 * registers the caller sets one by one.
 *
 * @param {any} context
 */
export function clearGeneralRegisters(context){
    if (context.block instanceof Uint8Array && context.layout?.bits === 64)
    {
        const { block, layout } = /** @type {BlockContext} */ (context);
        block.fill(0, layout.regs, layout.regs + 16 * 8);
        context.reg32.fill(0);
    }
}

/**
 * Sets a saved context's flags word, whole: the arithmetic record kept beside
 * it is dropped, since the word now says everything. For a thread sent into
 * code with the flags it is to start with: an exception handler, or where a
 * handler's context continues.
 *
 * @param {BlockContext} context
 * @param {number} value
 */
export function setContextEflags(context, value){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    view.setUint32(layout.eflags, value >>> 0, true);
    if ((layout.flagRecord ?? -1) >= 0)
    {
        view.setUint32(/** @type {number} */ (layout.flagRecord), 0, true);
    }
}

/**
 * A long-mode thread's registers whole, as an x64 CONTEXT carries them: the
 * sixteen general registers in the encoding's order, and the XMM registers and
 * MXCSR when given. What an exception's continuation is: RtlUnwindEx and a
 * handler that continues execution put back every non-volatile register a
 * frame saved, upper halves and XMM6 to XMM15 included, which the dword view
 * a context is otherwise moved with cannot say.
 *
 * @typedef {Object} LongRegisters
 * @property {bigint[]} [gpr]      Sixteen, rax..r15.
 * @property {Uint8Array} [xmm]    Sixteen registers of sixteen bytes.
 * @property {number} [mxcsr]
 */

/**
 * Writes `long` into a saved long-mode context. The low dwords of the first
 * eight registers are kept in `reg32` as well, which a restore writes last.
 *
 * @param {any} context  A block context of a 64-bit thread.
 * @param {LongRegisters} long
 */
export function setContextLong(context, long){
    const { block, layout } = /** @type {BlockContext} */ (context);
    if (!(block instanceof Uint8Array) || layout.bits !== 64)
    {
        throw new Error('cpu: a long-mode context is set on a 64-bit thread only');
    }
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    long.gpr?.forEach((value, index)=>{
        view.setBigUint64(layout.regs + index * 8, BigInt.asUintN(64, value), true);
        if (index < 8)
        {
            context.reg32[index] = Number(BigInt.asIntN(32, value));
        }
    });
    if (long.xmm)
    {
        block.set(long.xmm.subarray(0, 256), layout.xmm);
    }
    if (long.mxcsr !== undefined)
    {
        view.setUint32(layout.mxcsr, long.mxcsr >>> 0, true);
    }
}
