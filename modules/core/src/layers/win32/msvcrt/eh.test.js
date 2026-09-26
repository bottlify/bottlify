/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCxxExceptions, EH_EXCEPTION_NUMBER, EH_FRAME, EH_MAGIC } from './eh.js';
import { Disposition, EH_UNWINDING, RECORD } from '../kernel32/seh.js';

/** The registration frame of the function being handled, and its body's stack. */
const FRAME = 0x2f000;
const BODY_ESP = 0x2ef00;
const RECORD_AT = 0x28000;
const THREAD = { name: 'main' };

/**
 * Guest memory with a bump allocator for the tables a compiler would emit,
 * and a host that records every call into the guest.
 *
 * @param {Object} [options]
 * @param {(call: any) => any} [options.answer]  What a guest call returns.
 */
function machine(options = {}){
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const unwinds = [];
    /** @type {any[]} */
    const raised = [];
    /** @type {string[]} */
    const aborted = [];
    /** @type {string[]} */
    const diverged = [];
    let registers = {
        eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0x27000, ebp: 0, esi: 0, edi: 0, eip: 0x401000,
    };

    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const get = at=>view.getUint32(at, true);
    /** @param {number} size */
    const allocate = size=>{
        const at = next;
        next += size + 15 & ~15;
        return at;
    };
    /** @param {number[]} values */
    const words = values=>{
        const at = allocate(values.length * 4);
        values.forEach((/** @type {number} */ value, /** @type {number} */ index)=>
            put(at + index * 4, value));
        return at;
    };
    /** @param {string} name */
    const type = name=>{
        const at = allocate(8 + name.length + 1);
        [...name].forEach((char, index)=>{
            bytes[at + 8 + index] = char.charCodeAt(0);
        });
        return at;
    };

    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeMemory: (at, value)=>bytes.set(value, at),
        /** @param {number} at @param {number} max */
        readCString: (at, max)=>{
            let text = '';
            for (let i = 0; i < max && bytes[at + i] !== 0; i++)
            {
                text += String.fromCharCode(bytes[at + i]);
            }
            return text;
        },
        /** @param {number} at */
        isMapped: at=>at > 0 && at < bytes.length,
        registers: ()=>({ ...registers }),
        /** @param {any} call */
        callGuest: async call=>{
            calls.push({ ...call, state: get(FRAME + EH_FRAME.STATE) });
            return options.answer ? options.answer(call) : 0;
        },
        /** @param {Record<string, number>} target @param {{ below?: number }} [how] */
        continueAt: (target, how)=>({ continueAt: target, below: how?.below }),
        currentThread: ()=>THREAD,
        /** @param {any} what */
        raise: what=>{
            raised.push(what);
            return new Promise(()=>{});
        },
        /** @param {number} frame @param {number} address @param {any} how */
        unwind: async(frame, address, how)=>{
            unwinds.push({ frame, address, how });
            return { unwound: true };
        },
        /** @param {string} why */
        abort: why=>aborted.push(why),
        park: ()=>'parked',
        /** @param {string} api */
        divergence: api=>diverged.push(api),
    };

    return {
        bytes, put, get, words, type, allocate, calls, unwinds, raised, aborted, diverged,
        host,
        eh: createCxxExceptions(/** @type {any} */ (host)),
        /** @param {Record<string, number>} values */
        set: values=>{
            registers = { ...registers, ...values };
        },
    };
}

/**
 * A function's tables: an unwind map and try blocks, each with its handlers.
 *
 * @param {ReturnType<typeof machine>} m
 * @param {Object} shape
 * @param {{ toState: number, action: number }[]} shape.unwind
 * @param {{ low: number, high: number, catchHigh: number,
 *           handlers: { adjectives?: number, type: number, object?: number,
 *                       address: number }[] }[]} shape.tries
 * @param {number} [shape.magic]
 * @param {number} [shape.flags]
 */
function funcInfo(m, { unwind, tries, magic = EH_MAGIC.V3, flags = 0 }){
    const unwindMap = m.words(unwind.flatMap(entry=>[entry.toState, entry.action]));
    const tryMap = m.words(tries.flatMap(block=>[
        block.low, block.high, block.catchHigh, block.handlers.length,
        m.words(block.handlers.flatMap(handler=>[
            handler.adjectives ?? 0, handler.type, handler.object ?? 0, handler.address,
        ])),
    ]));
    return m.words([magic, unwind.length, unwindMap, tries.length, tryMap, 0, 0, 0, flags]);
}

/**
 * What a `throw` of one type describes: its catchable types and destructor.
 *
 * @param {ReturnType<typeof machine>} m
 * @param {{ type: number, properties?: number, mdisp?: number, size?: number,
 *           copy?: number }[]} catchables
 * @param {Object} [options]
 * @param {number} [options.destructor]
 * @param {number} [options.attributes]
 */
function throwInfo(m, catchables, { destructor = 0, attributes = 0 } = {}){
    const types = catchables.map(entry=>m.words([
        entry.properties ?? 0, entry.type, entry.mdisp ?? 0, -1, 0,
        entry.size ?? 4, entry.copy ?? 0,
    ]));
    const array = m.words([types.length, ...types]);
    return m.words([attributes, destructor, 0, array]);
}

/**
 * A C++ exception record for a thrown object.
 *
 * @param {ReturnType<typeof machine>} m
 * @param {number} object
 * @param {number} info
 * @param {number} [flags]
 */
function thrown(m, object, info, flags = 0){
    m.put(RECORD_AT + RECORD.CODE, EH_EXCEPTION_NUMBER);
    m.put(RECORD_AT + RECORD.FLAGS, flags);
    m.put(RECORD_AT + RECORD.PARAMETER_COUNT, 3);
    m.put(RECORD_AT + RECORD.INFORMATION, EH_MAGIC.V1);
    m.put(RECORD_AT + RECORD.INFORMATION + 4, object);
    m.put(RECORD_AT + RECORD.INFORMATION + 8, info);
    return RECORD_AT;
}

/**
 * Calls the frame handler the way the compiler's stub does: tables in ECX,
 * which the stub moved there out of EAX.
 *
 * @param {ReturnType<typeof machine>} m
 * @param {number} info
 * @param {number} record
 * @param {number} state
 */
function handle(m, info, record, state){
    m.put(FRAME + EH_FRAME.STATE, state);
    m.put(FRAME + EH_FRAME.SAVED_ESP, BODY_ESP);
    m.set({ ecx: info });
    return m.eh.frameHandler([record, FRAME, 0x26000, 0]);
}

test('the three handler spellings take the tables from ECX, where the stub put them', ()=>{
    const m = machine();
    for (const name of ['__CxxFrameHandler', '__CxxFrameHandler2', '__CxxFrameHandler3'])
    {
        const entry = /** @type {any} */ (m.eh.table)[name];
        assert.equal(entry.argBytes, 16);
        assert.equal(entry.convention, 'cdecl');
        assert.equal(entry.preserveResult, true, 'EAX is the trap\'s; the stub moves it to ECX');
    }
});

test('tables with a magic number no compiler emits are declined, and said so', async()=>{
    const m = machine();
    const info = funcInfo(m, { unwind: [], tries: [], magic: 0x12345678 });

    const answer = await handle(m, info, thrown(m, 0x3000, 0), 0);

    assert.equal(answer, Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.diverged, ['__CxxFrameHandler']);
});

test('a frame being unwound destroys what is alive, newest first, and declines', async()=>{
    const m = machine();
    const info = funcInfo(m, {
        unwind: [{ toState: -1, action: 0x5100 }, { toState: 0, action: 0x5200 }],
        tries: [],
    });

    const answer = await handle(m, info, thrown(m, 0x3000, 0, EH_UNWINDING), 1);

    assert.equal(answer, Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.calls.map(call=>call.entry), [0x5200, 0x5100]);
    assert.deepEqual(m.calls.map(call=>call.state), [0, -1 >>> 0],
        'each destructor runs with its object already off the state');
    assert.deepEqual(m.calls[0].registers, { ebp: FRAME + EH_FRAME.EBP });
});

test('a matching catch: unwind, build its object, run it, destroy the thrown one', async()=>{
    const m = machine({ answer: call=>{
        // The block records its own stack in the frame's slot, as compiled
        // code does, and answers where the function goes on.
        if (call.entry === 0x6000)
        {
            m.put(FRAME + EH_FRAME.SAVED_ESP, 0x26800);
            return 0x401234;
        }
        return 0;
    } });
    const err = m.type('.?AUErr@@');
    const info = funcInfo(m, {
        unwind: [{ toState: -1, action: 0 }, { toState: 0, action: 0x5200 }],
        tries: [{ low: 0, high: 1, catchHigh: 2, handlers: [
            { type: err, object: -0x20, adjectives: 8, address: 0x6000 },
        ] }],
    });
    const object = m.words([42]);
    const ti = throwInfo(m, [{ type: err }], { destructor: 0x7000 });

    const answer = await handle(m, info, thrown(m, object, ti), 1);

    assert.equal(m.unwinds[0].frame, FRAME, 'the frames below this one go first');
    assert.equal(m.unwinds[0].how.record, RECORD_AT);
    assert.equal(m.get(RECORD_AT + RECORD.FLAGS) & EH_UNWINDING, 0,
        'and the record reads as handled again once they have');
    assert.equal(m.get(FRAME + EH_FRAME.EBP - 0x20), object, 'a reference is the thrown object');
    assert.deepEqual(m.calls.map(call=>call.entry), [0x5200, 0x6000, 0x7000],
        'the try block\'s own objects, then the block, then the thrown object');
    assert.equal(m.calls[1].state, 2, 'the block runs past the try block\'s range');
    assert.deepEqual(m.calls[1].registers, { ebp: FRAME + EH_FRAME.EBP });
    assert.deepEqual(m.calls[2].registers, { ecx: object }, 'the destructor is thiscall');
    assert.deepEqual(answer, {
        continueAt: { eip: 0x401234, esp: BODY_ESP, ebp: FRAME + EH_FRAME.EBP },
        below: BODY_ESP,
    }, 'on the body\'s stack, not the one the block wrote over it');
    assert.equal(m.get(FRAME + EH_FRAME.SAVED_ESP), BODY_ESP);
});

test('types match by decorated name across descriptors, not only by address', async()=>{
    // A type used in two images has a descriptor in each.
    const m = machine({ answer: call=>(call.entry === 0x6000 ? 0x401000 : 0) });
    const ours = m.type('.?AUErr@@');
    const theirs = m.type('.?AUErr@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [{ type: ours, address: 0x6000 }] }] });

    await handle(m, info, thrown(m, m.words([1]), throwInfo(m, [{ type: theirs }])), 0);

    assert.ok(m.calls.some(call=>call.entry === 0x6000));
});

test('the first catch that takes the type wins; the rest are not asked', async()=>{
    const m = machine({ answer: call=>(call.entry >= 0x6000 ? 0x401000 : 0) });
    const a = m.type('.?AUA@@');
    const b = m.type('.?AUB@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [
            { type: a, address: 0x6000 },
            { type: b, address: 0x6100 },
            { type: 0, address: 0x6200 },
        ] }] });

    await handle(m, info, thrown(m, m.words([1]), throwInfo(m, [{ type: b }])), 0);

    assert.deepEqual(m.calls.map(call=>call.entry), [0x6100]);
});

test('a try block whose range does not hold the state is not looked in', async()=>{
    const m = machine();
    const any = m.type('.?AUX@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }, { toState: -1, action: 0 }],
        tries: [{ low: 1, high: 1, catchHigh: 1, handlers: [{ type: 0, address: 0x6000 }] }] });

    const answer = await handle(m, info, thrown(m, m.words([1]), throwInfo(m, [{ type: any }])), 0);

    assert.equal(answer, Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.calls, []);
});

test('a const object needs a const handler; a by-reference type a reference', async()=>{
    const m = machine({ answer: ()=>0x401000 });
    const t = m.type('.?AUT@@');
    const plain = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [{ type: t, address: 0x6000 }] }] });

    const constThrow = throwInfo(m, [{ type: t }], { attributes: 1 });
    assert.equal(await handle(m, plain, thrown(m, m.words([1]), constThrow), 0),
        Disposition.CONTINUE_SEARCH);

    const byReference = throwInfo(m, [{ type: t, properties: 2 }]);
    assert.equal(await handle(m, plain, thrown(m, m.words([1]), byReference), 0),
        Disposition.CONTINUE_SEARCH);
    assert.deepEqual(m.calls, []);
});

test('a class with a copy constructor is caught by value through it', async()=>{
    const m = machine({ answer: call=>(call.entry === 0x6000 ? 0x401000 : 0) });
    const t = m.type('.?AUT@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [
            { type: t, object: -0x30, address: 0x6000 },
        ] }] });
    const object = m.words([7, 8]);

    await handle(m, info, thrown(m, object, throwInfo(m, [{ type: t, size: 8, copy: 0x8000 }])), 0);

    const copy = m.calls.find(call=>call.entry === 0x8000);
    assert.deepEqual(copy?.registers, { ecx: FRAME + EH_FRAME.EBP - 0x30 });
    assert.deepEqual(copy?.args, [object]);
});

test('a plain type caught by value is copied, and a base is found at its displacement', async()=>{
    const m = machine({ answer: ()=>0x401000 });
    const base = m.type('.?AUBase@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [
            { type: base, object: -0x30, adjectives: 8, address: 0x6000 },
        ] }] });
    const object = m.words([1, 2, 3]);

    await handle(m, info, thrown(m, object, throwInfo(m, [{ type: base, mdisp: 8, size: 4 }])), 0);

    assert.equal(m.get(FRAME + EH_FRAME.EBP - 0x30), object + 8,
        'the reference points at the base inside the object');
});

test('a structured exception reaches catch (...) unless built to refuse it', async()=>{
    const m = machine({ answer: ()=>0x401000 });
    const record = RECORD_AT;
    m.put(record + RECORD.CODE, 0xc0000094);
    m.put(record + RECORD.PARAMETER_COUNT, 0);
    const tries = [{ low: 0, high: 0, catchHigh: 0, handlers: [{ type: 0, address: 0x6000 }] }];

    const refusing = funcInfo(m, { unwind: [{ toState: -1, action: 0 }], tries, flags: 1 });
    assert.equal(await handle(m, refusing, record, 0), Disposition.CONTINUE_SEARCH);

    const taking = funcInfo(m, { unwind: [{ toState: -1, action: 0 }], tries });
    const answer = await handle(m, taking, record, 0);
    assert.equal(/** @type {any} */ (answer).continueAt.eip, 0x401000);
});

test('throw raises the C++ exception code with the object and its type', async()=>{
    const m = machine();

    m.eh.table._CxxThrowException.handler([0x3000, 0x3100]);

    assert.equal(m.raised.length, 1);
    assert.equal(m.raised[0].code, EH_EXCEPTION_NUMBER);
    assert.deepEqual(m.raised[0].parameters, [EH_MAGIC.V1, 0x3000, 0x3100]);
    assert.equal(m.eh.table.__uncaught_exception.handler(), 1,
        'thrown and not yet caught');
});

test('the translator and the uncaught query are exported under msvcrt.dll\'s own names', ()=>{
    const m = machine();
    const table = /** @type {Record<string, any>} */ (m.eh.table);
    const setTranslator = '?_set_se_translator@@YAP6AXIPAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z';

    // msvcrt.spec: the C++ name only for the translator, the C name only for
    // the query; an import of either spelling resolves by that exact name.
    assert.equal(table._set_se_translator, undefined);
    assert.equal(table['?__uncaught_exception@@YA_NXZ'], undefined);
    assert.deepEqual([table[setTranslator].convention, table[setTranslator].argBytes],
        ['cdecl', 4]);
    assert.deepEqual([table.__uncaught_exception.convention,
        table.__uncaught_exception.argBytes], ['cdecl', 0]);

    assert.equal(table[setTranslator].handler([0x401200]), 0, 'none was installed');
    assert.equal(table[setTranslator].handler([0x401300]), 0x401200,
        'the previous translator comes back');
    assert.equal(table.__uncaught_exception.handler(), 0, 'nothing is in flight');
});

test('throw; inside a catch throws the same object again, and it is destroyed only once', async()=>{
    // The inner block rethrows, so the outer catch is the one that ends the
    // object's life -- the inner one never finishes.
    const m = machine({ answer: call=>{
        if (call.entry === 0x6000)
        {
            m.eh.table._CxxThrowException.handler([0, 0]);
            return new Promise(()=>{});
        }
        return 0;
    } });
    const t = m.type('.?AUT@@');
    const info = funcInfo(m, { unwind: [{ toState: -1, action: 0 }],
        tries: [{ low: 0, high: 0, catchHigh: 0, handlers: [{ type: t, address: 0x6000 }] }] });
    const object = m.words([1]);
    const ti = throwInfo(m, [{ type: t }], { destructor: 0x7000 });

    void handle(m, info, thrown(m, object, ti), 0);
    await new Promise(resolve=>setImmediate(resolve));

    assert.deepEqual(m.raised.map(what=>what.parameters), [[EH_MAGIC.V1, object, ti]],
        'the object being handled, not a null pair');
    assert.ok(!m.calls.some(call=>call.entry === 0x7000),
        'not destroyed by the block that rethrew');
});

test('throw; with nothing being handled terminates', async()=>{
    const m = machine();

    void m.eh.table._CxxThrowException.handler([0, 0]);
    await new Promise(resolve=>setImmediate(resolve));

    assert.deepEqual(m.aborted, ['throw; with no exception being handled']);
    assert.deepEqual(m.raised, []);
});

test('terminate calls the handler set_terminate installed, then aborts', async()=>{
    const m = machine();
    const { table } = m.eh;
    const set = table['?set_terminate@@YAP6AXXZP6AXXZ@Z'];

    assert.equal(set.handler([0x9000]), 0, 'the one it replaced');
    assert.equal(set.handler([0x9100]), 0x9000);
    void table['?terminate@@YAXXZ'].handler();
    await new Promise(resolve=>setImmediate(resolve));

    assert.deepEqual(m.calls.map(call=>call.entry), [0x9100]);
    assert.deepEqual(m.aborted, ['terminate']);
});

test('abort ends the process and never returns', ()=>{
    const m = machine();

    assert.equal(m.eh.table.abort.handler(), 'parked');
    assert.deepEqual(m.aborted, ['abort']);
});

test('type_info\'s vtable is data an image can bind to, not code', ()=>{
    const m = machine();
    const entry = /** @type {any} */ (m.eh.table)['??_7type_info@@6B@'];
    assert.equal(typeof entry.data, 'function');
    assert.ok(entry.data() instanceof Uint8Array);
});
