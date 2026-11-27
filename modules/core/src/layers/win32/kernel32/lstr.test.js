/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * lstrlen and lstrcpy in both widths as guest code, on cork's test machine,
 * against what the host's handlers answer: each call either answered in the
 * guest or handed to its trap, a stub here that marks the hand-over. Each
 * test runs again on the x86-64 routines, on cork's long-mode machine called
 * as the x64 convention calls, the trap stub keeping RCX and RDX to be held
 * to the call's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { lstrcpyCode, lstrcpyLongCode, lstrlenCode, lstrlenLongCode } from './lstr.js';
import { KEPT_64, callLong, longMachine } from '../../../../scripts/guest-code/long.mjs';

const TOP = 0x100000;
const HALT = 0xf000;
const STACK = 0x8000;
const HANDED = 0xe000;
const CODE = 0x20000;
const TEXT = 0x30000;
/** Where the 64-bit trap stub keeps RCX and RDX as it found them. */
const ARGS = 0xe100;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A machine with the four routines placed, and a call that says which side answered. */
function world(){
    const m = createTestMachine({ ramSize: 2 << 20 });
    m.write(HALT, [0xf4]);
    /** @type {Record<string, number>} */
    const at = {};
    let next = CODE;
    /**
     * @param {string} name @param {number} pop
     * @param {(at: number, trap: number) => Uint8Array} make
     */
    const place = (name, pop, make)=>{
        const trap = next;
        m.write(trap, [0xc7, 0x05, ...u32(HANDED), ...u32(1), 0x31, 0xc0, 0xc2, pop, 0]);
        const code = make(trap + 0x20, trap);
        m.write(trap + 0x20, code);
        at[name] = trap + 0x20;
        next = (trap + 0x20 + code.length + 0xff) & ~0xff;
    };
    place('lstrlenA', 4, (where, trap)=>lstrlenCode(1, where, trap, TOP));
    place('lstrlenW', 4, (where, trap)=>lstrlenCode(2, where, trap, TOP));
    place('lstrcpyA', 8, (where, trap)=>lstrcpyCode(1, where, trap, TOP));
    place('lstrcpyW', 8, (where, trap)=>lstrcpyCode(2, where, trap, TOP));
    /**
     * @param {string} name @param {number[]} args
     * @returns {{ eax: number, handed: boolean }}
     */
    const call = (name, args)=>{
        m.writeU32(HANDED, 0);
        m.writeU32(STACK, HALT);
        args.forEach((value, i)=>m.writeU32(STACK + 4 + i * 4, value));
        m.setReg('esp', STACK);
        m.setReg('esi', 0x51515151);
        m.setReg('edi', 0x7e7e7e7e);
        const exit = m.runProgram(at[name]);
        assert.equal(exit.kind, 3, `${name} ran to its return: ${JSON.stringify(exit)}`);
        assert.equal(m.reg('esp'), STACK + 4 + args.length * 4, `${name} popped its arguments`);
        assert.equal(m.reg('esi'), 0x51515151);
        assert.equal(m.reg('edi'), 0x7e7e7e7e);
        assert.equal(m.eflags() & 0x400, 0, 'the direction flag clear again');
        return { eax: m.reg('eax'), handed: m.readU32(HANDED) === 1 };
    };
    /** @param {number} address @param {string} text */
    const ansi = (address, text)=>m.write(address, [...text].map(c=>c.charCodeAt(0)).concat(0));
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>m.write(address,
        [...text, '\0'].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8]));
    return { m, call, ansi, wide };
}

/**
 * The same four over cork's long-mode machine, a pointer passed with its
 * upper half zero unless the test gives a bigint.
 */
function world64(){
    const m = longMachine();
    m.write(HALT, [0xf4]);
    /** @type {Record<string, number>} */
    const at = {};
    let next = CODE;
    /** @param {string} name @param {Uint8Array} code */
    const place = (name, code)=>{
        const trap = next;
        m.write(trap, [
            0xc7, 0x04, 0x25, ...u32(HANDED), ...u32(1),     // mov dword [HANDED], 1
            0x48, 0x89, 0x0c, 0x25, ...u32(ARGS),            // mov [ARGS], rcx
            0x48, 0x89, 0x14, 0x25, ...u32(ARGS + 8),        // mov [ARGS + 8], rdx
            0x31, 0xc0, 0xc3,                                // xor eax, eax; ret
        ]);
        const where = trap + 0x40;
        const bytes = code.slice();
        new DataView(bytes.buffer).setInt32(bytes.length - 4, trap - (where + bytes.length), true);
        m.write(where, bytes);
        at[name] = where;
        next = (where + bytes.length + 0xff) & ~0xff;
    };
    place('lstrlenA', lstrlenLongCode(1, TOP));
    place('lstrlenW', lstrlenLongCode(2, TOP));
    place('lstrcpyA', lstrcpyLongCode(1, TOP));
    place('lstrcpyW', lstrcpyLongCode(2, TOP));
    /**
     * @param {string} name @param {(number | bigint)[]} args
     * @returns {{ eax: number, handed: boolean }}
     */
    const call = (name, args)=>{
        m.write(HANDED, [0, 0, 0, 0]);
        const given = args.map(value=>(typeof value === 'bigint' ? value : BigInt(value >>> 0)));
        const { entry, halted } = callLong(m, at[name], { args: given, returnTo: HALT });
        assert.ok(halted && m.rip() === HALT + 1, `${name} ran to its return`);
        assert.equal(m.reg('rsp'), entry.rsp + 8n, `${name} took its frame down`);
        for (const register of KEPT_64)
        {
            assert.equal(m.reg(register), entry[register], `${name} kept ${register}`);
        }
        assert.equal(m.flags() & 0x400, 0, 'the direction flag clear again');
        const handed = m.read(HANDED, 4)[0] === 1;
        const rax = m.reg('rax');
        if (handed)
        {
            given.forEach((value, i)=>assert.equal(m.quad(ARGS + i * 8), value,
                `${name} handed over its argument ${i} as it came`));
        }
        else
        {
            assert.equal(rax >> 32n, 0n, `${name}'s answer is whole in RAX`);
        }
        return { eax: Number(rax & 0xffffffffn), handed };
    };
    /** @param {number} address @param {string} text */
    const ansi = (address, text)=>m.write(address, [...text].map(c=>c.charCodeAt(0)).concat(0));
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>m.write(address,
        [...text, '\0'].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8]));
    return { m, call, ansi, wide };
}

/**
 * A test on both machines: the i386 routines, then their x86-64.
 *
 * @param {string} name @param {(w: ReturnType<typeof world>) => void} body
 */
function both(name, body){
    test(name, ()=>body(world()));
    test(`${name} (x86-64)`, ()=>body(/** @type {any} */ (world64())));
}

both('lstrlenA and lstrlenW count in the guest, a null pointer is 0 there, and a pointer'
    + ' they cannot read without a fault is the host\'s', w=>{
    w.ansi(TEXT, 'hello, world');
    w.wide(TEXT + 0x100, 'héllo');
    w.ansi(TEXT + 0x200, '');
    assert.deepEqual(w.call('lstrlenA', [TEXT]), { eax: 12, handed: false });
    assert.deepEqual(w.call('lstrlenA', [TEXT + 7]), { eax: 5, handed: false });
    assert.deepEqual(w.call('lstrlenA', [TEXT + 0x200]), { eax: 0, handed: false });
    assert.deepEqual(w.call('lstrlenW', [TEXT + 0x100]), { eax: 5, handed: false });
    assert.deepEqual(w.call('lstrlenA', [0]), { eax: 0, handed: false });
    assert.deepEqual(w.call('lstrlenW', [0]), { eax: 0, handed: false });
    assert.equal(w.call('lstrlenA', [0x1234]).handed, true, 'the null region');
    assert.equal(w.call('lstrlenW', [0xfffe]).handed, true);
    assert.equal(w.call('lstrlenA', [TOP]).handed, true, 'past the top of RAM');
    assert.equal(w.call('lstrlenA', [0xfffffff0]).handed, true);
    // A string with no terminator before the top is the host's, not a fault.
    w.m.write(TOP - 4, [0x61, 0x61, 0x61, 0x61]);
    assert.equal(w.call('lstrlenA', [TOP - 4]).handed, true);
    w.m.write(TOP - 3, [0x61, 0, 0x61]);
    assert.equal(w.call('lstrlenW', [TOP - 3]).handed, true, 'a unit across the top');
});

both('lstrcpyA and lstrcpyW copy the source and its terminator and answer the destination', w=>{
    w.ansi(TEXT, 'source text');
    w.m.write(TEXT + 0x100, new Array(32).fill(0xcc));
    assert.deepEqual(w.call('lstrcpyA', [TEXT + 0x100, TEXT]),
        { eax: TEXT + 0x100, handed: false });
    assert.deepEqual([...w.m.read(TEXT + 0x100, 13)],
        [...'source text'].map(c=>c.charCodeAt(0)).concat(0, 0xcc));
    w.wide(TEXT + 0x200, 'wïde');
    assert.deepEqual(w.call('lstrcpyW', [TEXT + 0x300, TEXT + 0x200]),
        { eax: TEXT + 0x300, handed: false });
    assert.deepEqual([...w.m.read(TEXT + 0x300, 10)], [...w.m.read(TEXT + 0x200, 10)]);
    // Overlapping either way: the source as it was before the copy.
    w.ansi(TEXT + 0x400, 'abcdef');
    assert.equal(w.call('lstrcpyA', [TEXT + 0x402, TEXT + 0x400]).handed, false);
    assert.equal(String.fromCharCode(...w.m.read(TEXT + 0x400, 8)), 'ababcdef');
    w.ansi(TEXT + 0x500, 'abcdef');
    assert.equal(w.call('lstrcpyA', [TEXT + 0x4fe, TEXT + 0x500]).handed, false);
    assert.equal(String.fromCharCode(...w.m.read(TEXT + 0x4fe, 7)), 'abcdef\0');
    w.wide(TEXT + 0x600, 'abc');
    assert.equal(w.call('lstrcpyW', [TEXT + 0x602, TEXT + 0x600]).handed, false);
    assert.deepEqual([...w.m.read(TEXT + 0x600, 10)],
        [0x61, 0, 0x61, 0, 0x62, 0, 0x63, 0, 0, 0]);
    // What the host answers: a null or unreadable pointer on either side, a copy past the top.
    assert.equal(w.call('lstrcpyA', [0, TEXT]).handed, true);
    assert.equal(w.call('lstrcpyA', [TEXT, 0]).handed, true);
    assert.equal(w.call('lstrcpyW', [TEXT, 0x20]).handed, true);
    assert.equal(w.call('lstrcpyA', [TOP - 4, TEXT]).handed, true, 'no room below the top');
    assert.equal(String.fromCharCode(...w.m.read(TOP - 4, 4)), '\0\0\0\0', 'nothing written');
});

test('at 64 bits a pointer with an upper half is the host\'s, its arguments as they came', ()=>{
    const w = world64();
    w.ansi(TEXT, 'text');
    const high = BigInt(TEXT) | 1n << 32n;
    assert.deepEqual(w.call('lstrlenA', [TEXT]), { eax: 4, handed: false });
    assert.equal(w.call('lstrlenA', [high]).handed, true);
    assert.equal(w.call('lstrlenW', [high]).handed, true);
    assert.equal(w.call('lstrcpyA', [high, TEXT]).handed, true);
    assert.equal(w.call('lstrcpyA', [TEXT + 0x100, high]).handed, true);
    assert.equal(w.call('lstrcpyW', [TEXT + 0x100, high]).handed, true);
});
