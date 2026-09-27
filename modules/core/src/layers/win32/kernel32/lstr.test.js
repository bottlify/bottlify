/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * lstrlen and lstrcpy in both widths as guest code, on cork's test machine,
 * against what the host's handlers answer: each call either answered in the
 * guest or handed to its trap, a stub here that marks the hand-over.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { lstrcpyCode, lstrlenCode } from './lstr.js';

const TOP = 0x100000;
const HALT = 0xf000;
const STACK = 0x8000;
const HANDED = 0xe000;
const CODE = 0x20000;
const TEXT = 0x30000;

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

test('lstrlenA and lstrlenW count in the guest, a null pointer is 0 there, and a pointer'
    + ' they cannot read without a fault is the host\'s', ()=>{
    const w = world();
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

test('lstrcpyA and lstrcpyW copy the source and its terminator and answer the destination',
    ()=>{
        const w = world();
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
