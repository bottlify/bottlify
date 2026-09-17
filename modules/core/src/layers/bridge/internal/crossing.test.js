/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What one crossing costs with nothing but the dispatcher in the way.
 *
 * A stdcall of four dwords and a COM method of three, a million times each,
 * through the real dispatcher and the real vtable over a machine that answers
 * a read with an array index. The number is printed for whoever changes the
 * path; what is asserted is the shape that keeps it small -- the crossing
 * reuses what it hands out, times nothing it was not asked to time, and still
 * records the one call in eight that stands for the rest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParking } from './parking.js';
import { createDispatcher } from './dispatch.js';
import { createVtables } from './vtable.js';

const ESP = 0x3000;
const CALLS = 1_000_000;

function machine(){
    const words = new Uint32Array(0x10000);
    words[ESP >> 2] = 0x401234;
    /** @type {Record<string, number>} */
    const registers = { esp: ESP, ecx: 0, eax: 0, edx: 0 };
    const cpu = {
        /** @param {string} name */
        readReg32: name=>registers[name],
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            registers[name] = value;
        },
    };
    const memory = {
        /** @param {number} address */
        readU32: address=>words[address >>> 2],
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>{
            words[address >>> 2] = value;
        },
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>new Uint8Array(words.buffer, address, length),
        /** @param {number} address @param {number} length */
        window: (address, length)=>new Uint8Array(words.buffer, address, length),
        /**
         * @param {number} address @param {number} count
         * @param {number[]} into @param {number} [at]
         */
        readU32sInto: (address, count, into, at = 0)=>{
            for (let word = 0; word < count; word++)
            {
                into[at + word] = words[(address >>> 2) + word] | 0;
            }
        },
    };
    const thread = { name: 'main' };
    const parking = createParking({
        kernel: { currentThread: ()=>thread, parkThread: ()=>{} },
    });
    /** @type {string[]} */
    const phases = [];
    let sunk = 0;
    let errorReads = 0;
    const dispatcher = createDispatcher({
        cpu, memory, parking,
        profiler: {
            /** @param {string} name */
            begin: name=>{
                phases.push(name);
            },
            end: ()=>0,
        },
        lastError: ()=>{
            errorReads++;
            return 0;
        },
        onCall: ()=>{
            sunk++;
        },
        suspend: ()=>{},
    });
    let next = 0;
    /** @param {string} name @param {any} fn */
    const register = (name, fn)=>{
        const id = next++;
        dispatcher.register(id, { name, convention: 'stdcall', ...fn });
        return id;
    };
    /** @param {number[]} values */
    const push = values=>values.forEach((value, index)=>{
        words[(ESP + 4 + index * 4) >> 2] = value;
    });
    return {
        registers, dispatcher, register, push, words, memory, phases,
        sunk: ()=>sunk, errorReads: ()=>errorReads,
    };
}

/**
 * @param {{ dispatch: (id: number) => void }} dispatcher
 * @param {number} id
 * @returns {number} nanoseconds a call, best of five rounds
 */
function timeCalls(dispatcher, id){
    let best = Infinity;
    for (let round = 0; round < 5; round++)
    {
        const started = process.hrtime.bigint();
        for (let i = 0; i < CALLS; i++)
        {
            dispatcher.dispatch(id);
        }
        best = Math.min(best, Number(process.hrtime.bigint() - started) / CALLS);
    }
    return best;
}

test('a stdcall of four dwords reuses its arguments and frame, and times only the sample', t=>{
    const m = machine();
    m.push([1, 2, 3, 4]);
    /** @type {any[]} */
    const arrays = [];
    /** @type {any[]} */
    const frames = [];
    const id = m.register('KERNEL32.dll!Four', {
        argBytes: 16,
        /** @param {number[]} args @param {any} frame */
        handler: (args, frame)=>{
            if (arrays.length < 2)
            {
                arrays.push(args);
                frames.push(frame);
            }
            return args[0] + args[1] + args[2] + args[3];
        },
    });

    const perCall = timeCalls(m.dispatcher, id);
    t.diagnostic(`stdcall(4) crossing: ${perCall.toFixed(0)} ns a call in Node`);

    assert.equal(m.registers.eax, 10);
    assert.equal(arrays[0], arrays[1], 'one argument array for the life of the function');
    assert.equal(frames[0], frames[1], 'one frame per depth of nesting');
    assert.equal(m.sunk(), 5 * CALLS, 'the sink saw every call');
    assert.equal(m.errorReads(), 5 * CALLS, 'and the last error was read after each');
    assert.equal(m.phases.length, 5 * CALLS / 8, 'one crossing in eight is timed');
    assert.ok(m.phases.every(name=>name === 'trap'), 'and no handler phase without callPhases');
    assert.equal(m.dispatcher.detailed(1)[0].result, '0xa', 'the record still says the answer');
});

test('a COM method of three dwords: the pointer is resolved and no error is read', t=>{
    const m = machine();
    let heapAt = 0x8000;
    const vtables = createVtables({
        memory: m.memory,
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = heapAt;
            heapAt += bytes;
            return at;
        } },
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>0x1000 + m.register(name, fn) * 16,
    });
    /** @type {any[]} */
    const arrays = [];
    const methods = [
        { name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' },
        { name: 'AddRef', argBytes: 4, builtin: 'addRef' },
        { name: 'Release', argBytes: 4, builtin: 'release' },
        { name: 'SetThree', argBytes: 16,
            /** @param {any} object @param {number[]} args */
            invoke: (object, args)=>{
                if (arrays.length < 2)
                {
                    arrays.push(args);
                }
                return args[0] + args[1] + args[2];
            } },
    ];
    const pointer = vtables.publish({
        interfaceFor: ()=>({ methods }), addRef: ()=>1, release: ()=>1,
    }, '{IID}');
    m.push([pointer, 1, 2, 3]);
    const id = 3;

    const perCall = timeCalls(m.dispatcher, id);
    t.diagnostic(`COM method(3) crossing: ${perCall.toFixed(0)} ns a call in Node`);

    assert.equal(m.registers.eax, 6);
    assert.equal(arrays[0], arrays[1], 'one array of method arguments for the life of the method');
    assert.equal(m.errorReads(), 0, 'a method answers with an HRESULT; there is no error to read');
    assert.equal(m.sunk(), 5 * CALLS);
});
