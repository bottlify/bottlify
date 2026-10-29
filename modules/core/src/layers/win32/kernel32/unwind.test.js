/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNW_FLAG, createUnwinder, stackOf } from './unwind.js';

/**
 * A chunk of guest memory a test writes structures into and the unwinder
 * reads back, with one image mapped over a range and its exception directory
 * at a fixed spot.
 */
function machine({ imageBase = 0x40000, imageSize = 0x40000, tableRva = 0x1000 } = {}){
    const memory = new Uint8Array(0x200000);
    const view = new DataView(memory.buffer);
    /** @type {{ begin: number, end: number, info: number }[]} */
    const functions = [];
    return {
        memory,
        view,
        /** @param {number} at @param {number[]} bytes */
        put(at, bytes){ memory.set(bytes, at); },
        /** @param {number} at @param {bigint} value */
        putQ(at, value){ view.setBigUint64(at, BigInt.asUintN(64, value), true); },
        /** @param {number} at @param {number} value */
        putD(at, value){ view.setUint32(at, value >>> 0, true); },
        /**
         * One RUNTIME_FUNCTION, by absolute addresses; the table is laid out
         * at `tableRva` in order of the calls, as the linker sorts it.
         *
         * @param {number} begin @param {number} end @param {number} info
         */
        addFunction(begin, end, info){
            functions.push({ begin, end, info });
            functions.sort((a, b)=>a.begin - b.begin);
            functions.forEach((fn, index)=>{
                const at = imageBase + tableRva + index * 12;
                view.setUint32(at, fn.begin - imageBase >>> 0, true);
                view.setUint32(at + 4, fn.end - imageBase >>> 0, true);
                view.setUint32(at + 8, fn.info - imageBase >>> 0, true);
            });
        },
        host(){
            return {
                /** @param {number} address @param {number} length */
                readMemory: (address, length)=>memory.subarray(address, address + length),
                /** @param {number} address */
                imageOf: address=>(address >>> 0) >= imageBase
                    && (address >>> 0) < imageBase + imageSize
                    ? { base: imageBase, size: imageSize,
                        table: { address: tableRva, size: functions.length * 12 } }
                    : null,
            };
        },
        count: ()=>functions.length,
    };
}

/**
 * A fresh unwind context with a stack pointer and distinct register values.
 *
 * @param {number} rsp
 */
function context(rsp){
    return {
        gpr: Array.from({ length: 16 }, (_, index)=>BigInt(0x1000 + index)).map((v, i)=>
            (i === 4 ? BigInt(rsp >>> 0) : v)),
        rip: 0,
        eflags: 0x202,
        xmm: new Uint8Array(256),
        mxcsr: 0x1f80,
    };
}

test('a leaf function returns the address at the top of its stack', ()=>{
    const m = machine();
    const unwinder = createUnwinder(m.host());
    const stackTop = 0x100000;
    m.putQ(stackTop, 0x40500n); // the return address
    const ctx = context(stackTop);
    unwinder.unwindLeaf(ctx);
    assert.equal(ctx.rip, 0x40500);
    assert.equal(stackOf(ctx), stackTop + 8);
});

test('RtlLookupFunctionEntry finds the entry whose range holds the address', ()=>{
    const m = machine();
    m.addFunction(0x41000, 0x41100, 0x42000);
    m.addFunction(0x41200, 0x41300, 0x42010);
    m.addFunction(0x41400, 0x41500, 0x42020);
    const unwinder = createUnwinder(m.host());
    assert.equal(unwinder.lookup(0x41250)?.begin, 0x41200);
    assert.equal(unwinder.lookup(0x41400)?.unwindInfo, 0x42020);
    assert.equal(unwinder.lookup(0x41350), null, 'a gap between functions belongs to none');
    assert.equal(unwinder.lookup(0x9999), null, 'outside the image');
});

test('a prologue of push rbp / sub rsp is undone to the caller registers', ()=>{
    // mainstream prologue: push rbp (1 code), then sub rsp, 0x40 (alloc small).
    // UNWIND_INFO codes are in reverse order of the prologue, so the alloc
    // comes first.
    const m = machine();
    const info = 0x42000;
    m.put(info, [
        1, // version 1, no flags
        5, // prolog length: the two instructions
        2, // two code slots
        0, // no frame register
    ]);
    // code 1: at offset 5, ALLOC_SMALL of (7+1)*8 = 64
    m.put(info + 4, [5, 0x02 | (7 << 4)]);
    // code 0: at offset 1, PUSH_NONVOL rbp (register 5)
    m.put(info + 6, [1, 0x00 | (5 << 4)]);
    m.addFunction(0x41000, 0x41100, info);

    const rsp = 0x100000;
    const ctx = context(rsp);
    // The frame: [rsp..rsp+0x40) locals, [rsp+0x40] saved rbp, [rsp+0x48] return.
    m.putQ(rsp + 0x40, 0xaabbccn); // saved rbp
    m.putQ(rsp + 0x48, 0x40780n); // return address
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x41050));
    const unwinder = createUnwinder(m.host());
    const result = unwinder.virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x41050, ctx);
    assert.equal(ctx.gpr[5], 0xaabbccn, 'rbp restored from the frame');
    assert.equal(ctx.rip, 0x40780, 'returned to the caller');
    assert.equal(stackOf(ctx), rsp + 0x40 + 8 + 8, 'stack past locals, saved rbp and return');
    assert.equal(result.handler, 0, 'no handler flag set');
});

test('inside the prologue only the instructions already run are undone', ()=>{
    // At offset 1 -- after push rbp, before the sub rsp -- unwinding undoes the
    // push alone and the stack is one quadword higher, not the whole frame.
    const m = machine();
    const info = 0x42000;
    m.put(info, [1, 5, 2, 0]);
    m.put(info + 4, [5, 0x02 | (7 << 4)]);
    m.put(info + 6, [1, 0x00 | (5 << 4)]);
    m.addFunction(0x41000, 0x41100, info);

    const rsp = 0x100000;
    const ctx = context(rsp);
    m.putQ(rsp, 0xdeadn); // saved rbp sits at the top: only the push has run
    m.putQ(rsp + 8, 0x40999n); // and the return is right above it
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x41001));
    const result = createUnwinder(m.host()).virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x41001, ctx);
    assert.equal(ctx.gpr[5], 0xdeadn);
    assert.equal(ctx.rip, 0x40999);
    assert.equal(result.handler, 0, 'no handler is called from within a prologue');
});

test('a frame register is undone and saves addressed from it', ()=>{
    // The prologue, in order:
    //   off 1  push rbp              PUSH_NONVOL rbp
    //   off 5  sub rsp, 0x60         ALLOC_SMALL (0x60/8 - 1 = 11)
    //   off 9  lea rbp, [rsp+0x20]   SET_FPREG, frame offset 2 (×16 = 0x20)
    //   off 13 mov [rbp+..], rsi     SAVE_NONVOL rsi, offset 1 (×8 from the frame base)
    // The codes are stored in reverse prologue order.
    const m = machine();
    const info = 0x42000;
    m.put(info, [1, 13, 5, 5 | (2 << 4)]); // frame register rbp(5), frame offset 2
    m.put(info + 4, [13, 0x04 | (6 << 4), 1, 0]); // SAVE_NONVOL rsi, slot value 1
    m.put(info + 8, [9, 0x03 | (0 << 4)]); // SET_FPREG at offset 9
    m.put(info + 10, [5, 0x02 | (11 << 4)]); // ALLOC_SMALL 0x60 at offset 5
    m.put(info + 12, [1, 0x00 | (5 << 4)]); // PUSH rbp at offset 1
    m.addFunction(0x41000, 0x41100, info);

    const rsp = 0x100000;
    const ctx = context(rsp);
    // After the prologue rbp = (rsp body) + 0x20, so the frame base = rsp body.
    ctx.gpr[5] = BigInt(rsp + 0x20);
    // Physical layout from the body's rsp: locals; saved rsi at frame+1*8;
    // past the 0x60 allocation the saved rbp; then the return.
    m.putQ(rsp + 8, 0x7777n); // SAVE_NONVOL rsi
    m.putQ(rsp + 0x60, 0x1234n); // saved rbp (pushed before the allocation)
    m.putQ(rsp + 0x68, 0x40abcn); // return address
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x41050));
    createUnwinder(m.host()).virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x41050, ctx);
    assert.equal(ctx.gpr[6], 0x7777n, 'rsi restored from the frame base');
    assert.equal(ctx.gpr[5], 0x1234n, 'rbp restored');
    assert.equal(ctx.rip, 0x40abc);
    assert.equal(stackOf(ctx), rsp + 0x60 + 8 + 8);
});

test('the handler and its data are reported when the flag is set and asked for', ()=>{
    const m = machine();
    const info = 0x42000;
    m.put(info, [1 | (UNW_FLAG.EHANDLER << 3), 5, 2, 0]);
    m.put(info + 4, [5, 0x02 | (7 << 4)]);
    m.put(info + 6, [1, 0x00 | (5 << 4)]);
    // The handler RVA sits past the (even-padded) codes, then its data.
    m.putD(info + 8, 0x30000); // handler RVA
    m.putD(info + 12, 0xcafe); // first word of handler data
    m.addFunction(0x41000, 0x41100, info);

    const rsp = 0x100000;
    const ctx = context(rsp);
    m.putQ(rsp + 0x40, 0n);
    m.putQ(rsp + 0x48, 0x40780n);
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x41050));
    const got = createUnwinder(m.host()).virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x41050, ctx);
    assert.equal(got.handler, 0x40000 + 0x30000, 'absolute handler address');
    assert.equal(got.handlerData, info + 12, 'data begins past the handler RVA');
    const data = new DataView(m.memory.buffer).getUint32(got.handlerData, true);
    assert.equal(data, 0xcafe);

    // Not asked for as an unwind handler when only EHANDLER is set.
    const ctx2 = context(rsp);
    const unwindOnly = createUnwinder(m.host()).virtualUnwind(UNW_FLAG.UHANDLER, fn, 0x41050, ctx2);
    assert.equal(unwindOnly.handler, 0, 'EHANDLER-only data is not an unwind handler');
});

test('an epilogue is simulated so a return in it unwinds without undoing codes', ()=>{
    // After the body: add rsp, 0x40; pop rbp; ret. At the add, the unwinder
    // recognises the epilogue and simulates it rather than reading codes.
    const m = machine();
    const info = 0x42000;
    m.put(info, [1, 5, 2, 0]);
    m.put(info + 4, [5, 0x02 | (7 << 4)]);
    m.put(info + 6, [1, 0x00 | (5 << 4)]);
    m.addFunction(0x41000, 0x41100, info);
    // The epilogue bytes at 0x410f0: 48 83 c4 40 (add rsp,0x40), 5d (pop rbp), c3 (ret).
    m.put(0x410f0, [0x48, 0x83, 0xc4, 0x40, 0x5d, 0xc3]);

    const rsp = 0x100000;
    const ctx = context(rsp);
    m.putQ(rsp + 0x40, 0x5a5an); // saved rbp, reached by pop after the add
    m.putQ(rsp + 0x48, 0x40c0den); // return
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x410f0));
    createUnwinder(m.host()).virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x410f0, ctx);
    assert.equal(ctx.gpr[5], 0x5a5an, 'rbp popped in the epilogue');
    assert.equal(ctx.rip, 0x40c0de);
    assert.equal(stackOf(ctx), rsp + 0x40 + 8 + 8);
});

test('chained unwind info applies the primary function\'s prologue too', ()=>{
    // A chained entry (a separated funclet) that pushed nothing itself but
    // chains to a primary that pushed rbp and allocated: both are undone.
    const m = machine();
    const primary = 0x42000;
    m.put(primary, [1, 5, 2, 0]);
    m.put(primary + 4, [5, 0x02 | (7 << 4)]);
    m.put(primary + 6, [1, 0x00 | (5 << 4)]);

    const chained = 0x42100;
    m.put(chained, [1 | (UNW_FLAG.CHAININFO << 3), 0, 0, 0]);
    // No codes; the chained RUNTIME_FUNCTION follows, pointing at the primary.
    const runtimeAt = chained + 4; // count 0 → codes occupy 0 slots, padded to 0
    m.putD(runtimeAt, 0x1000); // begin RVA (unused by unwind)
    m.putD(runtimeAt + 4, 0x1100);
    m.putD(runtimeAt + 8, primary - 0x40000); // the primary's info RVA
    m.addFunction(0x41200, 0x41300, chained);

    const rsp = 0x100000;
    const ctx = context(rsp);
    m.putQ(rsp + 0x40, 0xbeefn);
    m.putQ(rsp + 0x48, 0x40f00n);
    const fn = /** @type {any} */ (createUnwinder(m.host()).lookup(0x41250));
    createUnwinder(m.host()).virtualUnwind(UNW_FLAG.EHANDLER, fn, 0x41250, ctx);
    assert.equal(ctx.gpr[5], 0xbeefn, 'the primary\'s saved rbp');
    assert.equal(ctx.rip, 0x40f00);
});

test('a table added at run time is searched like an image\'s', ()=>{
    const m = machine();
    const unwinder = createUnwinder(m.host());
    const base = 0x180000;
    // One entry at base+0x2000, describing base+0..0x100, info at base+0x3000.
    m.putD(base + 0x2000, 0);
    m.putD(base + 0x2000 + 4, 0x100);
    m.putD(base + 0x2000 + 8, 0x3000);
    assert.equal(unwinder.lookup(base + 0x50), null, 'unknown until added');
    assert.ok(unwinder.add(base + 0x2000, 1, base));
    assert.equal(unwinder.lookup(base + 0x50)?.begin, base);
    assert.equal(unwinder.known(base + 0x50), true);
    assert.ok(unwinder.remove(base + 0x2000));
    assert.equal(unwinder.lookup(base + 0x50), null, 'gone once removed');
});
