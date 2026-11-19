/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A pointer in memory: `ptr(address)` and `setPtr(address, value)`, a dword to
 * the i386 (the code of `u32` and `setU32`) and a quadword at 64 bits, held to
 * the same JavaScript below 4 GiB at both widths and, on cork's long-mode
 * machine over a wide window, past it, where a list's links and a stored
 * pointer have upper halves a dword load would drop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestCodeError, compileModule } from './compile.mjs';
import { DATA, equivalence, random } from './equivalence.mjs';
import { CODE_64, HIGH_64, callLong, longMachine } from './long.mjs';

const SAMPLE = `
/**
 * The last node of a list whose nodes begin with the next one's address.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} node
 * @returns {ptr}
 */
export function last({ ptr }, node){
    let at = node;
    let next = ptr(at);
    while (next !== 0)
    {
        at = next;
        next = ptr(at);
    }
    return at;
}

/**
 * The byte a table's entry points at: a pointer loaded by an index, read
 * through with an offset.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} table @param {u32} index @param {i32} offset
 * @returns {u32}
 */
export function through({ ptr, u8, pointerBytes }, table, index, offset){
    const entry = ptr(table + index * pointerBytes);
    if (entry === 0)
    {
        return 0xffffffff;
    }
    return u8(entry + offset) >>> 0;
}

/**
 * A slot given a pointer moved by an index, the one after it an integer, and
 * what the slot held answered.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {ptr} slot @param {ptr} target @param {u32} index
 * @returns {ptr}
 */
export function link({ ptr, setPtr, pointerBytes }, slot, target, index){
    const held = ptr(slot);
    setPtr(slot, target + index + 8);
    setPtr(slot + pointerBytes, index);
    setPtr(slot + pointerBytes * 2, ptr(slot));
    return held;
}

/**
 * A word claimed where a pointer and an offset say: lock cmpxchg at the whole address.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} words @param {u32} mine
 * @returns {u32}
 */
export function claim({ compareExchange }, words, mine){
    return compareExchange(words + 4, 0, mine) >>> 0;
}

/**
 * The node two links on, through a function of the module that answers a pointer.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} node
 * @returns {ptr}
 */
export function twoOn({ ptr }, node){
    const next = held({ ptr }, node - 8);
    if (next === 0)
    {
        return 0;
    }
    return held({ ptr }, next - 8);
}

/**
 * A pointer loaded and returned as it is.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} slot
 * @returns {ptr}
 */
export function held({ ptr }, slot){
    return ptr(slot + 8);
}
`;

/** @param {string} text */
async function load(text){
    const url = `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
    const values = await import(url);
    /** @type {Record<string, any>} */
    const compiled = {};
    for (const fn of compileModule(text, { file: 'loads.js', values }))
    {
        compiled[fn.name] = fn;
    }
    /** @type {Record<string, any>} */
    const long = {};
    for (const fn of compileModule(text, { file: 'loads.js', values, bits: 64 }))
    {
        long[fn.name] = fn;
    }
    return { values, compiled, long };
}

/** @param {number[]} words  dwords, or quadwords' low halves when `size` is 8 */
const laid = (words, /** @type {4 | 8} */ size)=>{
    const bytes = new Uint8Array(words.length * size);
    const view = new DataView(bytes.buffer);
    words.forEach((word, i)=>view.setUint32(i * size, word >>> 0, true));
    return bytes;
};

test('ptr and setPtr below 4 GiB: the i386 by dwords, the x86-64 by quadwords', async()=>{
    const { values, compiled, long } = await load(SAMPLE);
    assert.deepEqual(Object.keys(long).sort(), Object.keys(compiled).sort());
    const narrow = equivalence(compiled, values, undefined, {});
    const wide = equivalence(compiled, values, undefined, long);
    const next = random(71);
    for (const [size, run] of /** @type {const} */ ([[4, narrow.same], [8, wide.sameAt64]]))
    {
        for (let i = 0; i < 60; i++)
        {
            // A list of up to seven nodes scattered over the area, and a table of them.
            const nodes = Array.from({ length: 1 + next() % 7 }, (_, n)=>DATA + 0x100 + n * 0x40);
            const order = nodes.map((_, n)=>n).sort(()=>next() % 3 - 1);
            const memory = new Uint8Array(0x400);
            const view = new DataView(memory.buffer);
            order.forEach((n, k)=>{
                view.setUint32(nodes[n] - DATA, k + 1 < order.length ? nodes[order[k + 1]] : 0,
                    true);
                memory[nodes[n] - DATA + 16] = 0x30 + n;
            });
            const table = laid([...nodes, 0], size);
            memory.set(table, 0x300 - 0x40);
            const input = /** @type {[number, Uint8Array][]} */ ([[DATA, memory]]);
            run('last', { stack: [nodes[order[0]]], memory: input });
            run('through', { stack: [DATA + 0x300 - 0x40, next() % (nodes.length + 1),
                16 - next() % 3], memory: input });
            run('link', { stack: [DATA + 0x380, nodes[next() % nodes.length], next() % 64],
                memory: input });
            run('held', { stack: [DATA + 0x300 - 0x40 - 8], memory: input });
            run('twoOn', { stack: [nodes[order[0]]], memory: input });
            run('claim', { stack: [DATA + 0x380 + (next() % 2) * 0x10, 1 + next() % 100],
                memory: [[DATA, Uint8Array.from(memory, (byte, at)=>(at === 0x394 ? 7 : byte))]] });
        }
    }
});

test('ptr costs the i386 what u32 does, and setPtr what setU32 does', ()=>{
    const source = `
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} slot @param {ptr} value
 * @returns {ptr}
 */
export function swap({ LOAD, STORE }, slot, value){
    const was = LOAD(slot);
    STORE(slot + 4, value);
    return was;
}
`;
    const [pointer] = compileModule(source.replaceAll('LOAD', 'ptr').replaceAll('STORE', 'setPtr'),
        { file: 'a.js' });
    const dwords = source.replaceAll('LOAD', 'u32').replaceAll('STORE', 'setU32')
        .replace('@returns {ptr}', '@returns {u32}').replace('@param {ptr} value',
            '@param {u32} value');
    const [dword] = compileModule(dwords, { file: 'a.js' });
    assert.deepEqual(pointer.code, dword.code);
});

const HIGH = HIGH_64 + 0x300000;
const TWIN = 0x300000;
const HALT = 0x0f00;

test('past 4 GiB: a list\'s links, a table\'s entry and a stored pointer are quadwords', async()=>{
    const { long } = await load(SAMPLE);
    /** @param {string} name @param {(m: import('./long.mjs').LongMachine) => void} lay
     *  @param {bigint[]} args */
    const run = (name, lay, args)=>{
        const m = longMachine({ window: 2 ** 33 });
        m.write(CODE_64, long[name].code);
        m.write(HALT, [0xf4]);
        lay(m);
        const { halted } = callLong(m, CODE_64, { args, returnTo: HALT });
        assert.ok(halted && m.rip() === HALT + 1, `${name} returns`);
        return m;
    };
    /** @param {import('./long.mjs').LongMachine} m @param {number} at @param {number} value */
    const quad = (m, at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
        m.write(at, Array.from(bytes));
    };
    // Three nodes past 4 GiB; the low twin of the first says the list ends there.
    const list = run('last', m=>{
        quad(m, HIGH, HIGH + 0x40);
        quad(m, HIGH + 0x40, HIGH + 0x80);
        quad(m, HIGH + 0x80, 0);
        quad(m, TWIN + 0x40, 0);
    }, [BigInt(HIGH)]);
    assert.equal(list.reg('rax'), BigInt(HIGH + 0x80), 'the last node, its address whole');

    const read = run('through', m=>{
        quad(m, HIGH + 0x100 + 16, HIGH + 0x200);
        m.write(HIGH + 0x200 - 3, [0x77]);
        m.write(TWIN + 0x200 - 3, [0x11]);
    }, [BigInt(HIGH + 0x100), 2n, BigInt.asUintN(64, -3n)]);
    assert.equal(read.reg('rax'), 0x77n, 'the byte past 4 GiB, not its twin\'s');

    const stored = run('link', m=>{
        quad(m, HIGH + 0x300, HIGH + 0x555);
    }, [BigInt(HIGH + 0x300), BigInt(HIGH + 0x1000), 5n]);
    assert.equal(stored.reg('rax'), BigInt(HIGH + 0x555), 'what the slot held, whole');
    const view = new DataView(Uint8Array.from(stored.read(HIGH + 0x300, 24)).buffer);
    assert.equal(view.getBigUint64(0, true), BigInt(HIGH + 0x1000 + 5 + 8), 'a pointer stored');
    assert.equal(view.getBigUint64(8, true), 5n, 'an integer stored, extended by zeros');
    assert.equal(view.getBigUint64(16, true), BigInt(HIGH + 0x1000 + 5 + 8),
        'a loaded pointer stored as it was loaded');

    const two = run('twoOn', m=>{
        quad(m, HIGH, HIGH + 0x40);
        quad(m, HIGH + 0x40, HIGH + 0x80);
        quad(m, TWIN + 0x40, 0x1234);
    }, [BigInt(HIGH)]);
    assert.equal(two.reg('rax'), BigInt(HIGH + 0x80), 'a module call\'s pointer, whole');

    const claimed = run('claim', m=>{
        m.write(TWIN + 4, [9, 0, 0, 0]);
    }, [BigInt(HIGH), 0x55n]);
    assert.equal(claimed.reg('rax'), 0n, 'the word past 4 GiB was free');
    assert.deepEqual(Array.from(claimed.read(HIGH + 4, 4)), [0x55, 0, 0, 0], 'and is taken');
    assert.deepEqual(Array.from(claimed.read(TWIN + 4, 4)), [9, 0, 0, 0], 'its twin untouched');
});

test('a loaded pointer is refused where code would take half of it', ()=>{
    /** @param {string} body @param {string} [returns] */
    const refused = (body, returns = 'u32')=>{
        const source = `
/**
 * @guestCode cdecl
 * @param {Guest} guest @param {ptr} slot
 * @returns {${returns}}
 */
export function f({ ptr, u8 }, slot){
${body}
}
`;
        for (const bits of /** @type {const} */ ([32, 64]))
        {
            assert.throws(()=>compileModule(source, { file: 'r.js', bits }), GuestCodeError,
                `${body.trim()} at ${bits} bits`);
        }
    };
    refused('    return (ptr(slot) * 2) >>> 0;');
    refused('    const n = 1 + (ptr(slot) & 3);\n    return ptr(slot) + n;');
    refused('    /** @type {u32} */\n    let low = 0;\n    low = ptr(slot);\n    return low;');
});
