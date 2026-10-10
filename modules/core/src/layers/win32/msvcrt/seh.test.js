/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createCrtSeh, SCOPE_FRAME, SCOPE_ENTRY, NO_TRY_LEVEL, JMP_BUF, JMP_COOKIE,
} from './seh.js';
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
    /** @type {any[]} */
    const calls = [];
    /** @type {{ targetFrame: number, address: number }[]} */
    const unwound = [];
    /** @type {any[]} */
    const unwoundWith = [];
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
            calls.push(call);
            return options.answer ? options.answer(call.entry) : 0;
        },
        /**
         * @param {Record<string, number>} target
         * @param {{ below?: number }} [how]
         */
        continueAt: (target, how)=>({ continueAt: target, below: how?.below }),
        currentThread: ()=>THREAD,
        teb: ()=>TEB,
        /**
         * @param {number} targetFrame @param {number} address
         * @param {any} [how]
         */
        unwind: async(targetFrame, address, how)=>{
            unwound.push({ targetFrame, address });
            unwoundWith.push(how);
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
        put(FRAME + SCOPE_FRAME.SAVED_ESP, 0x1f000);
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
        host, called, calls, unwound, unwoundWith, put, get, scope, record,
        crt: createCrtSeh(host),
        registers: ()=>registers,
    };
}

/** The thread every call here is made on. */
const THREAD = { name: 'main' };

/** A thread block, whose first word heads the handler chain. */
const TEB = 0x78000;

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

test('a filter that accepts unwinds to its frame and the thread goes on in its block', async()=>{
    const m = machine({ answer: entry=>entry === 0x63000 ? 1 : 0 });
    m.scope(0, [{ enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 }]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.deepEqual(m.unwound, [{ targetFrame: FRAME, address: 0x64000 }],
        'the frames between the fault and this one go away first');
    assert.equal(m.unwoundWith[0].record, RECORD_AT, 'shown the exception being handled');
    assert.equal(m.unwoundWith[0].thread, THREAD);
    assert.deepEqual(answer, {
        continueAt: { eip: 0x64000, esp: 0x1f000, ebp: FRAME + SCOPE_FRAME.EBP },
        below: 0x1f000,
    }, 'the block runs on the body\'s stack, with EBP where the compiler\'s code expects it');
    assert.equal(m.get(FRAME + SCOPE_FRAME.TRY_LEVEL), NO_TRY_LEVEL,
        'the level it is leaving is no longer entered');
});

test('a filter runs with EBP set from the frame, and finds the exception pointers', async()=>{
    // The compiler's filter reads its function's locals through EBP and the
    // exception through [EBP-0x14]; neither is an argument.
    const m = machine({ answer: ()=>0 });
    m.scope(0, [{ enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 }]);

    await m.crt.exceptHandler3([m.record(0), FRAME, 0x15000, 0]);

    const [call] = m.calls;
    assert.deepEqual(call.registers, { ebp: FRAME + 0x10 });
    assert.deepEqual(call.args, []);
    assert.equal(SCOPE_FRAME.EBP - 0x14, SCOPE_FRAME.POINTERS,
        'the slot the compiler reads, [EBP-0x14], is the one written');
    const pointers = m.get(FRAME + SCOPE_FRAME.POINTERS);
    assert.equal(m.get(pointers), RECORD_AT);
    assert.equal(m.get(pointers + 4), 0x15000);
    assert.ok(call.stackAtRest <= pointers, 'and the filter runs below them');
});

test('an accepted level runs the finally blocks nested inside it before its own block', async()=>{
    // __try { __try { fault } __finally { A } } __except (1) { B }: A runs,
    // then B -- and the level is lowered before A runs, so a fault inside A
    // does not find A still entered.
    /** @type {number[]} */
    const levels = [];
    const m = machine({ answer: entry=>{
        levels.push(m.get(FRAME + SCOPE_FRAME.TRY_LEVEL));
        return entry === 0x63000 ? 1 : 0;
    } });
    m.scope(1, [
        { enclosing: NO_TRY_LEVEL, filter: 0x63000, target: 0x64000 },
        { enclosing: 0, filter: 0, target: 0x61000 },
    ]);

    const answer = await m.crt.exceptHandler3([m.record(0), FRAME, 0, 0]);

    assert.deepEqual(m.called, [0x63000, 0x61000], 'the filter, then the finally inside it');
    assert.deepEqual(levels, [1, 0], 'the finally ran with its own level already left');
    assert.equal(/** @type {any} */ (answer).continueAt.eip, 0x64000);
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

/** The call a program made to setjmp: its return address and where it was pushed. */
const CALL = { callerStack: 0x3ff00, hostReturn: 0x401234 };

test('setjmp marks where its call returns to, and longjmp goes back there', async()=>{
    const m = machine();
    const { table } = m.crt;
    m.put(TEB, 0x2a000);

    assert.equal(table._setjmp.handler([0x70000], CALL), 0,
        'zero says this is the call that set the mark');
    assert.equal(m.get(0x70000 + JMP_BUF.EIP), 0x401234,
        'the return address, not the stub the processor is standing in');
    assert.equal(m.get(0x70000 + JMP_BUF.ESP), 0x3ff04,
        'and the stack as the return leaves it -- the slot below is reused by the next call');
    assert.equal(m.get(0x70000 + JMP_BUF.REGISTRATION), 0x2a000, 'and so is the chain\'s head');

    m.host.setRegisters({ esp: 0x10, eip: 0x99 });
    const answer = table.longjmp.handler([0x70000, 5]);

    assert.equal(answer, 5, 'setjmp appears to return what longjmp was given');
    assert.equal(m.registers().esp, 0x3ff04);
    assert.equal(m.registers().eip, 0x401234);
    assert.deepEqual(m.unwound, [], 'the chain has not moved: nothing to unwind');
});

test('the pair are cdecl: the caller pops the arguments, not the stub', ()=>{
    // A stub that popped them too would leave the stack four bytes off after
    // every setjmp.
    const { table } = machine().crt;
    for (const name of ['_setjmp', '_setjmp3', 'longjmp'])
    {
        assert.equal(/** @type {any} */ (table)[name].convention, 'cdecl', name);
    }
});

test('longjmp with zero still returns something setjmp cannot mistake', async()=>{
    // Zero is what the first arrival returns. Passing it through would have the
    // program take the same branch for ever.
    const m = machine();
    m.crt.table._setjmp.handler([0x70000], CALL);

    assert.equal(m.crt.table.longjmp.handler([0x70000, 0]), 1);
});

test('longjmp out of guarded frames unwinds them on the way back to the mark', async()=>{
    const m = machine();
    m.put(TEB, 0x2a000);
    m.crt.table._setjmp.handler([0x70000], CALL);
    m.put(TEB, 0x29000); // frames registered since the mark

    const answer = /** @type {any} */ (await m.crt.table.longjmp.handler([0x70000, 3]));

    assert.deepEqual(m.unwound.map(u=>u.targetFrame), [0x2a000],
        'every frame registered since the mark gets its handler called');
    assert.equal(answer.continueAt.eax, 3);
    assert.equal(answer.continueAt.eip, 0x401234);
    assert.equal(answer.below, 0x3ff08,
        'what the thread was doing below the caller -- above setjmp\'s argument -- is over');
});

test('_setjmp3 keeps what a longjmp back needs to unwind the setting frame itself', async()=>{
    // The compiler passes the unwind routine and the level after the count;
    // a longjmp back into the same frame calls that routine with the buffer.
    const m = machine();
    m.put(CALL.callerStack + 12, 0x6b000); // the unwind routine
    m.put(CALL.callerStack + 16, 0);       // the level to unwind to
    m.put(TEB, 0x2a000);

    m.crt.table._setjmp3.handler([0x70000, 2], CALL);

    assert.equal(m.get(0x70000 + JMP_BUF.COOKIE), JMP_COOKIE);
    assert.equal(m.get(0x70000 + JMP_BUF.UNWIND_FUNC), 0x6b000);
    assert.equal(m.get(0x70000 + JMP_BUF.TRY_LEVEL), 0);

    const answer = /** @type {any} */ (await m.crt.table.longjmp.handler([0x70000, 1]));
    const routine = m.calls.find(call=>call.entry === 0x6b000);
    assert.deepEqual(routine?.args, [0x70000], 'the routine is handed the buffer');
    assert.equal(answer.below, CALL.callerStack + 4 + 4 * 4,
        'the caller stands above all four words it gave _setjmp3');
});

test('_local_unwind2 runs the finally blocks down to the level it is given', async()=>{
    const m = machine();
    m.scope(2, [
        { enclosing: NO_TRY_LEVEL, filter: 0, target: 0x61000 },
        { enclosing: 0, filter: 0, target: 0x62000 },
        { enclosing: 1, filter: 0, target: 0x63000 },
    ]);

    await m.crt.table._local_unwind2.handler([FRAME, 0]);

    assert.deepEqual(m.called, [0x63000, 0x62000], 'down to, not including, the level named');
    assert.equal(m.get(FRAME + SCOPE_FRAME.TRY_LEVEL), 0);
    assert.deepEqual(m.calls[0].registers, { ebp: FRAME + 0x10 });
});

test('a finally run by this runtime is an abnormal termination; one inline is not', async()=>{
    /** @type {number[]} */
    const seen = [];
    const m = machine({ answer: ()=>{
        seen.push(m.crt.table._abnormal_termination.handler());
        return 0;
    } });
    m.scope(0, [{ enclosing: NO_TRY_LEVEL, filter: 0, target: 0x61000 }]);

    await m.crt.exceptHandler3([m.record(EH_UNWINDING), FRAME, 0, 0]);

    assert.deepEqual(seen, [1], 'inside the finally the unwind ran');
    assert.equal(m.crt.table._abnormal_termination.handler(), 0,
        'and outside it, a finally reached by falling out of its block');
});

test('_seh_longjmp_unwind answers to its undecorated name and the decorated one', ()=>{
    const table = /** @type {Record<string, any>} */ (machine().crt.table);
    assert.ok(table._seh_longjmp_unwind);
    assert.equal(table._seh_longjmp_unwind, table['_seh_longjmp_unwind@4']);
    assert.equal(table._seh_longjmp_unwind.argBytes, 4);
});
