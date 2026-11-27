/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit dispatcher and unwinder over an image and a stack past 4 GiB,
 * where every address - a frame's RIP and RSP, its handler, a scope's filter
 * and target, a record's ULONG_PTRs, the continuation a catch block answers
 * in RAX - is whole only with every bit of it, and its low dword is another
 * place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeh64 } from './seh64.js';
import { createUnwinder } from './unwind.js';
import { wholeAddresses } from '../../bridge/internal/dispatch.js';
import { declareAddresses } from '../common/pointers.js';
import { POINTER_ARGUMENTS } from '../common/pointer-arguments.js';

/** Where a 64-bit game's image lies at its own base; the stack here lies past it too. */
const WIDE = 0x140000000;

/**
 * An image at `WIDE` read through the real unwinder: one function, F at RVA
 * 0x1000-0x1100, whose prologue is `sub rsp, 28h` and whose unwind data names
 * this engine's C handler (a stub at RVA 0x3000) with one scope - its filter
 * at RVA 0x1050, its __except block at 0x1080. The thread stands in a host
 * call F made from RVA 0x1020, RSP at 0xc000 with the return on it; F's own
 * return, at 0xc030, is zero: the walk's end.
 *
 * @param {{ callFunclet?: (call: any, read: (at: number) => bigint) => bigint,
 *     interpreter?: any }} [options]
 *     What each funclet answers in RAX; a C++-like handler for the stub
 *     instead of the C one.
 */
function wideMachine({ callFunclet = ()=>0n, interpreter } = {}){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @param {number} at @param {number} [length] */
    const offset = (at, length = 1)=>{
        assert.ok(at >= WIDE && at + length <= WIDE + bytes.length,
            `0x${at.toString(16)} is mapped: no address was cut to its low dword`);
        return at - WIDE;
    };
    /** @param {number} at */
    const read = at=>view.getBigUint64(offset(at, 8), true);
    /** @param {number} rva @param {number[]} words */
    const dwords = (rva, words)=>words.forEach((word, index)=>
        view.setUint32(rva + index * 4, word, true));
    dwords(0x100, [0x1000, 0x1100, 0x2000]);
    // Version 1, EHANDLER | UHANDLER, a prologue of 4 bytes and one code: at
    // 4, UWOP_ALLOC_SMALL of (4 + 1) * 8 bytes.
    bytes.set([0x19, 4, 1, 0, 4, 0x42, 0, 0], 0x2000);
    dwords(0x2008, [0x3000, 1, 0x1000, 0x1100, 0x1050, 0x1080]);
    const stack = WIDE + 0xc000;
    view.setBigUint64(0xc000, BigInt(WIDE + 0x1020), true);
    const gpr = Array.from({ length: 16 }, ()=>0n);
    gpr[4] = BigInt(stack);
    /** @param {number} at @param {number} length */
    const readMemory = (at, length)=>bytes.slice(offset(at, length), offset(at, length) + length);
    const unwinder = createUnwinder({
        readMemory,
        imageOf: at=>(at >= WIDE && at < WIDE + bytes.length
            ? { base: WIDE, size: bytes.length, table: { address: 0x100, size: 12 } } : null),
    });
    /** @type {any[]} */
    const funclets = [];
    const seh = createSeh64(/** @type {any} */ ({
        unwinder,
        readMemory,
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            bytes.set(data, offset(at, data.length)),
        longState: ()=>({ gpr, eflags: 0x202, xmm: new Uint8Array(256), mxcsr: 0x1f80 }),
        currentThread: ()=>({}),
        handlerStubs: ()=>(interpreter ? [] : [WIDE + 0x3000]),
        interpreters: ()=>(interpreter ? [{ stubs: [WIDE + 0x3000], interpreter }] : []),
        callFunclet: (/** @type {any} */ call)=>{
            funclets.push(call);
            return Promise.resolve(callFunclet(call, read));
        },
        continueAt: (/** @type {any} */ where)=>({ continued: where }),
    }));
    return { seh, view, read, funclets, stack };
}

test('RaiseException\'s ULONG_PTRs and the frames past 4 GiB reach an __except filter whole,'
    + ' and the thread goes on in its block', async()=>{
    // Past 4 GiB, past 2^53 - a ULONG_PTR of -1 - and one that is another's
    // low dword: each read back from EXCEPTION_RECORD.ExceptionInformation.
    const parameters = [0x123456780n, 0xffffffffffffffffn, 0x7fff00001234n, 0x23456780n];
    /** @type {any} */
    let seen = null;
    const { seh, view, funclets, stack } = wideMachine({
        callFunclet: (call, read)=>{
            // EXCEPTION_POINTERS in RCX.
            const record = Number(read(call.rcx));
            const context = Number(read(call.rcx + 8));
            seen = {
                entry: call.entry, frame: call.rdx,
                address: read(record + 0x10),
                count: read(record + 0x18),
                information: Array.from({ length: 4 }, (_, index)=>read(record + 0x20 + index * 8)),
                rip: read(context + 0xf8),
                rsp: read(context + 0x78 + 4 * 8),
            };
            // EXCEPTION_EXECUTE_HANDLER, whatever RAX's high half holds.
            return 0xffffffff00000001n;
        },
    });
    parameters.forEach((value, index)=>view.setBigUint64(0xd000 + index * 8, value, true));
    const answer = await seh.table.RaiseException.handler([0xe0001234, 0, 4, WIDE + 0xd000]);
    assert.equal(funclets.length, 1, 'the filter, once');
    assert.equal(seen.entry, WIDE + 0x1050, 'the filter, at its whole address');
    assert.deepEqual(seen.information, parameters, 'every ULONG_PTR whole');
    assert.equal(seen.count, 4n);
    assert.equal(seen.address, BigInt(WIDE + 0x1020), 'raised from F, whole');
    assert.equal(seen.rip, BigInt(WIDE + 0x1020), 'the frame\'s RIP, whole');
    assert.equal(seen.rsp, BigInt(stack + 8), 'and its RSP');
    assert.equal(seen.frame, stack + 8, 'the establisher frame, F\'s RSP after its prologue');
    assert.equal(answer.continued.rip, WIDE + 0x1080, 'on in the __except block');
    assert.equal(answer.continued.rsp, stack + 8, 'on F\'s own stack');
    assert.equal(answer.continued.long.gpr[0], 0xe0001234n, 'the code in RAX');
});

test('a catch block\'s continuation past 4 GiB comes back from RAX whole', async()=>{
    // A C++ frame handler as eh64's runs one: the catch funclet answers in RAX
    // where its function goes on.
    const interpreter = {
        /** @param {any} visit @param {any} pass */
        search: async(visit, pass)=>{
            const rip = await pass.callNested(WIDE + 0x1090, { rcx: 0, rdx: visit.establisher },
                visit.context);
            return pass.continueAt({ ...visit.context, rip });
        },
        unwind: async()=>{},
    };
    const { seh, funclets } = wideMachine({ interpreter, callFunclet: ()=>BigInt(WIDE + 0x10a0) });
    const answer = await seh.raise({ code: 0xe06d7363,
        parameters: [0x19930520, WIDE + 0xd000, WIDE + 0x4000, WIDE] });
    assert.equal(funclets[0].entry, WIDE + 0x1090);
    assert.equal(answer.continued.rip, WIDE + 0x10a0, 'not its low dword');
});

test('the unwind tables\' entries take a 64-bit caller\'s addresses whole, as the bridge'
    + ' hands them', async()=>{
    const { seh, read, view } = wideMachine();
    // What each declares, or its signature does where it declares nothing.
    declareAddresses({ 'ntdll.dll': seh.table }, POINTER_ARGUMENTS);
    /**
     * A call as the bridge makes it: each value its dword, its high half
     * beside it, and the declared addresses joined again (`wholeAddresses`).
     *
     * @param {any} spec @param {number[]} values
     */
    const call = (spec, values)=>{
        const args = values.map(value=>value % 2 ** 32 | 0);
        const high = values.map(value=>Math.floor(value / 2 ** 32));
        wholeAddresses(spec.addresses ?? null, args, high);
        return spec.handler(Object.assign(args, { high }));
    };
    const out = WIDE + 0xe000;
    assert.equal(await call(seh.table.RtlLookupFunctionEntry, [WIDE + 0x1020, out, 0]),
        BigInt(WIDE + 0x100), 'F\'s RUNTIME_FUNCTION, whole');
    assert.equal(read(out), BigInt(WIDE), 'and the image base');
    assert.equal(await call(seh.table.RtlPcToFileHeader, [WIDE + 0x1020, out]), BigInt(WIDE));

    // F's frame undone from inside it, as a runtime's own unwinder asks.
    const context = WIDE + 0xa000;
    seh.writeContext(context, { gpr: Array.from({ length: 16 }, (_, index)=>(index === 4
        ? BigInt(WIDE + 0xc008) : 0n)), rip: WIDE + 0x1020, eflags: 0x202,
    xmm: new Uint8Array(256), mxcsr: 0x1f80 });
    const handlerData = WIDE + 0xe010;
    const establisher = WIDE + 0xe018;
    const handler = await call(seh.table.RtlVirtualUnwind, [1, WIDE, WIDE + 0x1020,
        WIDE + 0x100, context, handlerData, establisher, 0]);
    assert.equal(handler, BigInt(WIDE + 0x3000), 'the language handler, whole');
    assert.equal(read(handlerData), BigInt(WIDE + 0x200c), 'its data');
    assert.equal(read(establisher), BigInt(WIDE + 0xc008), 'the frame');
    const unwound = seh.readContext(context);
    assert.equal(unwound.rip, 0, 'F\'s return: the walk\'s end here');
    assert.equal(unwound.gpr[4], BigInt(WIDE + 0xc038), 'past it, whole');

    // Code made at run time past 4 GiB, described by a table relative to its
    // own base: found through it by its whole address, the base whole.
    const madeBase = WIDE + 0x8000;
    view.setUint32(0x7000, 0x100, true);
    view.setUint32(0x7004, 0x200, true);
    view.setUint32(0x7008, 0x400, true);
    assert.equal(call(seh.table.RtlAddFunctionTable, [WIDE + 0x7000, 1, madeBase]), 1);
    assert.equal(await call(seh.table.RtlLookupFunctionEntry, [madeBase + 0x150, out, 0]),
        BigInt(WIDE + 0x7000), 'the added entry');
    assert.equal(read(out), BigInt(madeBase), 'relative to the base it was added with');
    assert.equal(call(seh.table.RtlDeleteFunctionTable, [WIDE + 0x7000]), 1);

    // The same through a growable table, its range two ULONG_PTRs.
    const growable = WIDE + 0xe020;
    assert.equal(call(seh.table.RtlAddGrowableFunctionTable, [growable, WIDE + 0x7000, 1, 1,
        madeBase, madeBase + 0x1000]), 0);
    assert.equal(await call(seh.table.RtlLookupFunctionEntry, [madeBase + 0x150, out, 0]),
        BigInt(WIDE + 0x7000), 'the growable table\'s entry');
    call(seh.table.RtlDeleteGrowableFunctionTable, [Number(read(growable))]);

    // A JIT's range past 4 GiB, its base a DWORD64 in two dwords: a lookup
    // there waits on its callback rather than answering at once.
    assert.equal(call(seh.table.RtlInstallFunctionTableCallback, [
        3, 0, madeBase % 2 ** 32, Math.floor(madeBase / 2 ** 32), 0x1000, WIDE + 0x5000, 0,
        0]), 1);
    assert.ok(call(seh.table.RtlLookupFunctionEntry, [madeBase + 0x150, out, 0])
        instanceof Promise, 'the range is the one the address lies in');
});

test('RtlUnwindEx to a target past 4 GiB goes on there whole, its return value and a'
    + ' consolidation callback\'s answer too', async()=>{
    // From the host call F made, to F's own frame: no termination handler
    // between, the target's registers taken on.
    const plain = wideMachine();
    const answer = await plain.seh.table.RtlUnwindEx.handler([plain.stack + 8, WIDE + 0x1080, 0,
        WIDE + 0x7777, 0, 0]);
    assert.equal(answer.continued.rip, WIDE + 0x1080);
    assert.equal(answer.continued.rsp, plain.stack + 8);
    assert.equal(answer.continued.long.gpr[0], BigInt(WIDE + 0x7777), 'the return value whole');

    // STATUS_UNWIND_CONSOLIDATE: the record's first parameter is called at the
    // target and answers in RAX where the thread goes on.
    const consolidating = wideMachine({ callFunclet: ()=>BigInt(WIDE + 0x10b0) });
    consolidating.view.setUint32(0xd800, 0x80000029, true);
    consolidating.view.setBigUint64(0xd818, 1n, true);
    consolidating.view.setBigUint64(0xd820, BigInt(WIDE + 0x1060), true);
    const consolidated = await consolidating.seh.table.RtlUnwindEx.handler([
        consolidating.stack + 8, WIDE + 0x1080, WIDE + 0xd800, 0, 0, 0]);
    assert.equal(consolidating.funclets[0].entry, WIDE + 0x1060, 'the callback, whole');
    assert.equal(consolidated.continued.rip, WIDE + 0x10b0, 'where it answered, whole');
});
