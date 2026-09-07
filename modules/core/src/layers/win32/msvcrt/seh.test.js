/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrtSeh, SCOPE_FRAME, SCOPE_ENTRY, NO_TRY_LEVEL } from './seh.js';
import { Disposition, EH_UNWINDING, RECORD } from '../kernel32/seh.js';

const FRAME = 0x20000;
const TABLE = 0x30000;
const RECORD_AT = 0x10000;

/**
 * A frame with a scope table, as a compiler would have emitted it.
 *
 * @param {Object} [options]
 * @param {(entry: number) => number} [options.answer]
 */
function machine(options = {}){
    const bytes = new Uint8Array(0x80000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const called = [];
    /** @type {{ targetFrame: number, address: number }[]} */
    const unwound = [];
    /** @type {Record<string, number>} */
    let registers = { esp: 0x40000, eip: 0x401000, ebp: 0x50, ebx: 0x51, edi: 0x52, esi: 0x53 };

    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeMemory: (at, value)=>bytes.set(value, at),
        /** @param {number} at */
        isMapped: at=>at > 0 && at < bytes.length,
        registers: ()=>({ ...registers }),
        /** @param {Record<string, number>} values */
        setRegisters: values=>{
            registers = { ...registers, ...values };
        },
        /** @param {{ entry: number }} call */
        callGuest: async call=>{
            called.push(call.entry);
            return options.answer ? options.answer(call.entry) : 0;
        },
        /** @param {number} targetFrame @param {number} address */
        unwind: async(targetFrame, address)=>{
            unwound.push({ targetFrame, address });
            return { unwound: true };
        },
    };

    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const get = at=>view.getUint32(at, true);

    /**
     * @param {number} tryLevel
     * @param {{ enclosing: number, filter: number, target: number }[]} entries
     */
    const scope = (tryLevel, entries)=>{
        put(FRAME + SCOPE_FRAME.TABLE, TABLE);
        put(FRAME + SCOPE_FRAME.TRY_LEVEL, tryLevel);
        put(FRAME + SCOPE_FRAME.SAVED_ESP, 0x3f000);
        entries.forEach((entry, index)=>{
            const at = TABLE + index * SCOPE_ENTRY.SIZE;
            put(at + SCOPE_ENTRY.ENCLOSING, entry.enclosing);
            put(at + SCOPE_ENTRY.FILTER, entry.filter);
            put(at + SCOPE_ENTRY.TARGET, entry.target);
        });
    };

    /** @param {number} flags */
    const record = flags=>{
        put(RECORD_AT + RECORD.FLAGS, flags);
        return RECORD_AT;
    };

    return {
        host, called, unwound, put, get, scope, record,
        crt: createCrtSeh(host),
        registers: ()=>registers,
    };
}

test('while unwinding, every finally runs from the level entered outwards', async()=>{
    // A frame being discarded can never claim the exception, so both levels'
    // finally blocks run and the search goes on elsewhere.
    const m = machine();
    m.scope(1, [
        { enclosing: NO_TRY_LEVEL, filter: 0, target: 0x61000 },
        { enclosing: 0, filter: 0, target: 0x62000 },
    ]);

    const answer = await m.crt.exceptHandler3([m.record(EH_UNWINDING), FRAME, 0, 0]);

    assert.deepEqual(m.called, [0x62000, 0x61000], 'innermost first, then the one enclosing it');
    assert.equal(answer, Disposition.CONTINUE_SEARCH);
});

test('a level with a filter is not a finally, and does not run while unwinding', async()=>{
    // The one asymmetry in the table: a filter of zero marks a finally, and
    // only those run on the way out.
    const m = machine();
    m.scope(1, [
        { enclosing: NO_TRY_LEVEL, filter: 0, target: 0x61000 },
        { enclosing: 0, filter: 0x63000, target: 0x64000 },
    ]);

    await m.crt.exceptHandler3([m.record(EH_UNWINDING), FRAME, 0, 0]);

    assert.deepEqual(m.called, [0x61000], 'the guarded block is not a finally');
});

test('otherwise each filter is asked, innermost outwards', async()=>{
    const m = machine({ answer: ()=>0 });
    m.scope(1, [
        { enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 },
        { enclosing: 0, filter: 0x65000, target: 0x66000 },
    ]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.deepEqual(m.called, [0x65000, 0x63000]);
    assert.equal(answer, Disposition.CONTINUE_SEARCH, 'nobody wanted it');
});

test('a filter that accepts unwinds to its frame and enters its block', async()=>{
    const m = machine({ answer: entry=>entry === 0x63000 ? 1 : 0 });
    m.scope(0, [{ enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 }]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.equal(answer, Disposition.CONTINUE_EXECUTION);
    assert.deepEqual(m.unwound, [{ targetFrame: FRAME, address: 0x64000 }],
        'the frames between the fault and this one go away first');
    assert.equal(m.registers().eip, 0x64000, 'and the block runs');
    assert.equal(m.registers().esp, 0x3f000,
        'on the stack the function started with, not the one the fault left');
    assert.equal(m.get(FRAME + SCOPE_FRAME.TRY_LEVEL), NO_TRY_LEVEL,
        'the level it is leaving is no longer entered');
});

test('a filter that says it fixed the fault resumes without unwinding', async()=>{
    const m = machine({ answer: ()=>-1 });
    m.scope(0, [{ enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 }]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.equal(answer, Disposition.CONTINUE_EXECUTION);
    assert.deepEqual(m.unwound, [], 'nothing is discarded; the instruction runs again');
});

test('a table that cannot be read is declined, not claimed', async()=>{
    // Saying "not mine" leaves it to the next frame, which is the only answer
    // that cannot be wrong.
    const m = machine();
    m.put(FRAME + SCOPE_FRAME.TABLE, 0);
    m.put(FRAME + SCOPE_FRAME.TRY_LEVEL, 0);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.equal(answer, Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.called, []);
});

test('a frame with nothing entered asks nobody', async()=>{
    const m = machine();
    m.scope(NO_TRY_LEVEL, [{ enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 }]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.equal(answer, Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.called, []);
});

test('setjmp marks a place and longjmp returns to it', async()=>{
    const m = machine();
    const { table } = m.crt;

    assert.equal(table._setjmp.handler([0x70000]), 0,
        'zero says this is the call that set the mark');
    assert.equal(m.get(0x70000 + 16), 0x40000, 'the stack pointer is part of the mark');
    assert.equal(m.get(0x70000 + 20), 0x401000);

    m.host.setRegisters({ esp: 0x10, eip: 0x99 });
    table.longjmp.handler([0x70000, 5]);

    assert.equal(m.registers().esp, 0x40000);
    assert.equal(m.registers().eip, 0x401000);
    assert.equal(m.registers().eax, 5, 'and setjmp appears to return what longjmp was given');
});

test('longjmp with zero still returns something setjmp cannot mistake', async()=>{
    // Zero is what the first arrival returns. Passing it through would have the
    // program take the same branch for ever.
    const m = machine();
    m.crt.table._setjmp.handler([0x70000]);
    m.crt.table.longjmp.handler([0x70000, 0]);

    assert.equal(m.registers().eax, 1);
});
