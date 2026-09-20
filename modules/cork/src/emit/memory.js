/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Memory access in translated code: the page-flag test before every load
 * and store, the precise fault it leads to, the `stale` exit after a store
 * into a page that holds translated code, and the undo log a differential
 * build records before every store.
 *
 * Every access goes through the wasm memory's own bounds check as well; the
 * page test is what makes a fault precise (a wasm trap unwinds the function
 * and the registers held in locals with it), what makes a store into
 * translated code visible, and what will carry the memory layer's
 * protections. The test is a shift, a byte load and a branch per access
 * (two loads when the access may span a page); `roadmap/cork-plan.md` 2.9
 * measures its share.
 */

import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import { Tables } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { I32 } from './flags.js';
import { Exit, Local } from './region.js';

/** @typedef {import('./region.js').RegionEmitter} E */

/**
 * With the address of a `size`-byte access in `addr`: reads the page flags
 * of its first and its last byte into `pflags` and leaves with #GP, before
 * the instruction, when either page is inaccessible.
 *
 * @param {E} e @param {number} size
 * @param {{ counted?: boolean }} [options]  false inside a `rep` loop, where the
 *     instruction is not counted and a fault leaves at it without uncounting
 */
export function checkAccess(e, size, { counted = true } = {}){
    const { b } = e;
    const table = e.layout.tables + Tables.PAGE_FLAGS;
    b.localGet(Local.addr).i32const(12).op(I32.shrU).load('i32_8u', { offset: table });
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(size - 1).op(I32.add).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: table }).op(I32.or);
    }
    b.localSet(Local.pflags);
    b.localGet(Local.pflags).i32const(PageFlag.INACCESSIBLE).op(I32.and);
    e.openIf('inaccessible', EMPTY);
    if (counted)
    {
        e.exitBefore(e.current.eip, Exit.FAULT, 13);
    }
    else
    {
        e.exitAt(e.current.eip, Exit.FAULT, 13);
    }
    e.close();
}

/**
 * Before a store of `size` bytes at `addr`, whose page flags `checkAccess`
 * left in `pflags`: records the old bytes when the module keeps an undo
 * log, and when the page holds translated code notes the address and
 * raises `stale`, which the block turns into a `stale` exit right after the
 * instruction (`emitStaleExit`) and every other exit folds in.
 *
 * @param {E} e @param {number} size
 */
export function noteStore(e, size){
    const { b } = e;
    if (e.context.undo !== undefined)
    {
        b.localGet(Local.addr).i32const(size).call(e.context.undo);
    }
    b.localGet(Local.pflags).i32const(PageFlag.HAS_CODE).op(I32.and);
    if (e.layout.codePages >= 0)
    {
        // The other executor's own table too: its compiled page is as much
        // code as this engine's, and the runtime dirties its cache.
        b.localGet(Local.addr).i32const(12).op(I32.shrU)
            .load('i32_8u', { offset: e.layout.codePages }).op(I32.or);
    }
    e.openIf('code', EMPTY);
    b.i32const(1).localSet(Local.stale);
    b.i32const(0).localGet(Local.addr)
        .store('i32', { offset: e.layout.tables + Tables.STALE_ADDRESS });
    b.i32const(0).i32const(size).store('i32', { offset: e.layout.tables + Tables.STALE_SIZE });
    e.close();
    e.staleCheck = true;
}

/**
 * Sets `addr` to the stack pointer and checks a `size`-byte access there.
 *
 * @param {E} e @param {number} size
 */
export function stackAccess(e, size){
    e.b.localGet(Local.reg + 4).localSet(Local.addr);
    checkAccess(e, size);
}

/**
 * After an instruction that stored: leaves `stale` with EIP at the next
 * instruction when the store went into a code page.
 *
 * @param {E} e @param {number} next
 */
export function emitStaleExit(e, next){
    e.b.localGet(Local.stale);
    e.openIf('stale', EMPTY);
    e.exitAt(next, Exit.STALE);
    e.close();
}

/**
 * The undo helper a differential module carries: `(address, size)` appends
 * an entry of the address, the size and the sixteen bytes at the address to
 * the ring at `layout.tables + Tables.UNDO_RING`, counting in `UNDO_HEAD`.
 * Sixteen bytes are read whatever the size: the ring's reader uses `size`,
 * and the bytes past a store at the very end of RAM are the tables.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {number} the function index
 */
export function addUndoHelper(m, layout){
    const type = m.type({ params: [ValType.i32, ValType.i32], results: [] });
    const head = layout.tables + Tables.UNDO_HEAD;
    const ring = layout.tables + Tables.UNDO_RING;
    // locals: 0 address, 1 size, 2 slot
    const body = new Body();
    body.i32const(0).load('i32', { offset: head })
        .i32const(Tables.UNDO_ENTRIES - 1).op(I32.and)
        .i32const(Tables.UNDO_ENTRY).op(0x6c).localSet(2);
    body.localGet(2).localGet(0).store('i32', { offset: ring });
    body.localGet(2).localGet(1).store('i32', { offset: ring + 4 });
    body.localGet(2).localGet(0).load('i64', { offset: layout.ramBase })
        .store('i64', { offset: ring + 8 });
    body.localGet(2).localGet(0).load('i64', { offset: layout.ramBase + 8 })
        .store('i64', { offset: ring + 16 });
    body.i32const(0).i32const(0).load('i32', { offset: head }).i32const(1).op(I32.add)
        .store('i32', { offset: head });
    return m.function(type, [ValType.i32], body.toBytes());
}

/**
 * The entries a run left in the undo ring, oldest first, and whether the
 * ring wrapped (in which case the oldest entries are gone and the reader
 * must fall back to whole-memory comparison).
 *
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {{ entries: { address: number, size: number, old: Uint8Array }[], wrapped: boolean }}
 */
export function readUndoLog(memory, layout){
    const view = new DataView(memory.buffer);
    const head = view.getUint32(layout.tables + Tables.UNDO_HEAD, true);
    const wrapped = head > Tables.UNDO_ENTRIES;
    const count = Math.min(head, Tables.UNDO_ENTRIES);
    const first = wrapped ? head - Tables.UNDO_ENTRIES : 0;
    const entries = [];
    for (let i = 0; i < count; i++)
    {
        const slot = layout.tables + Tables.UNDO_RING + ((first + i) & (Tables.UNDO_ENTRIES - 1))
            * Tables.UNDO_ENTRY;
        const size = view.getUint32(slot + 4, true);
        entries.push({
            address: view.getUint32(slot, true),
            size,
            old: new Uint8Array(memory.buffer.slice(slot + 8, slot + 8 + size)),
        });
    }
    return { entries, wrapped };
}

/**
 * Clears the undo ring's count.
 *
 * @param {WebAssembly.Memory} memory
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export function resetUndoLog(memory, layout){
    new DataView(memory.buffer).setUint32(layout.tables + Tables.UNDO_HEAD, 0, true);
}

/**
 * The spans the entries cover, merged and sorted: what a differential run
 * compares and restores.
 *
 * @param {{ address: number, size: number }[]} entries
 * @returns {{ start: number, end: number }[]}
 */
export function spansOf(entries){
    const sorted = entries.map(({ address, size })=>({ start: address, end: address + size }))
        .sort((a, b)=>a.start - b.start);
    /** @type {{ start: number, end: number }[]} */
    const out = [];
    for (const span of sorted)
    {
        const last = out[out.length - 1];
        if (last && span.start <= last.end)
        {
            last.end = Math.max(last.end, span.end);
        }
        else
        {
            out.push({ ...span });
        }
    }
    return out;
}
