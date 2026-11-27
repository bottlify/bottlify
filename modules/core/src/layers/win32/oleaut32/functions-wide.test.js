/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OLE Automation's generated entry points in a 64-bit process whose memory
 * lies past 4 GiB, called as the bridge calls them: each address argument
 * whole where the spec or the signature table declares it. A conversion's
 * out pointer, a DECIMAL's and a string's are addresses; a BSTR written
 * through an out pointer is eight bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationFunctions } from './functions.js';
import { guestWindow } from '../msvcrt/guest-window.fixture.js';
import { declareAddresses } from '../common/pointers.js';
import { POINTER_ARGUMENTS } from '../common/pointer-arguments.js';
import { wholeAddresses } from '../../bridge/internal/dispatch.js';

const BASE = 0x140000000;
const S_OK = 0;
const VT_I4 = 3;

/** Offsets in the window. */
const OUT = 0x100;
const DEC = 0x200;
const TEXT = 0x300;
const VARIANT = 0x400;
const HEAP = 0x8000;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let next = BASE + HEAP;
    const table = createAutomationFunctions(/** @type {any} */ ({
        guest: guestWindow(bytes, { base: BASE, pointerSize: 8 }),
        heap: {
            /** @param {number} size */
            allocate(size){
                const at = next;
                next += size + 15 & ~15;
                return at;
            },
            free: ()=>{},
        },
        divergence: ()=>{},
    }));
    declareAddresses({ 'OLEAUT32.dll': table }, POINTER_ARGUMENTS);
    /** @type {Record<string, any>} */
    const specs = table;
    /**
     * The handler called with each argument as a 64-bit caller passes it.
     *
     * @param {string} name @param {number[]} words  the 32-bit layout's dwords, an address whole
     */
    const call = (name, words)=>{
        const spec = specs[name];
        const args = words.map(word=>word % 2 ** 32);
        const high = words.map(word=>Math.floor(word / 2 ** 32));
        wholeAddresses(spec.addresses ?? null, args, high);
        return /** @type {number} */ (spec.handler(Object.assign(args, { high }))) >>> 0;
    };
    /** @param {number} at */
    const quad = at=>Number(view.getBigUint64(at, true));
    return { bytes, view, specs, call, quad };
}

test('every conversion declares its out pointer and the DECIMAL or string it reads', ()=>{
    const { specs } = setup();
    const types = 'I1|UI1|I2|UI2|I4|UI4|I8|UI8|R4|R8|Date|Cy|Bool|Dec';
    const family = new RegExp(`^Var(?:(?:${types}|Bstr)From(?:${types}|Str|Disp)`
        + '|Cy(?:Add|Sub|Mul|MulI4|MulI8|Abs|Neg|Fix|Int|Round)'
        + '|Dec(?:Add|Sub|Mul|Div|Abs|Neg|Fix|Int|Round))$');
    const generated = Object.keys(specs).filter(name=>family.test(name));
    assert.ok(generated.length > 200, `${generated.length} conversions`);
    for (const name of generated)
    {
        const spec = specs[name];
        const out = spec.argBytes / 4 - 1;
        const places = spec.addresses ?? POINTER_ARGUMENTS[name] ?? [];
        assert.ok(places.includes(out), `${name} declares its out pointer, dword ${out}`);
        if (/From(?:Dec|Str|Disp)$|^VarDec(?:Add|Sub|Mul|Div|Fix|Int|Round|Abs|Neg)$/.test(name))
        {
            assert.ok(places.includes(0), `${name} declares the address it reads`);
        }
    }
});

test('a conversion writes through an out pointer past 4 GiB and reads its DECIMAL there', ()=>{
    const m = setup();
    assert.equal(m.call('VarI1FromI4', [-5, BASE + OUT]), S_OK);
    assert.equal(m.view.getInt8(OUT), -5);
    assert.equal(m.call('VarDecFromI4', [1234, BASE + DEC]), S_OK);
    assert.equal(m.call('VarI4FromDec', [BASE + DEC, BASE + OUT]), S_OK);
    assert.equal(m.view.getInt32(OUT, true), 1234);
    assert.equal(m.call('VarDecAdd', [BASE + DEC, BASE + DEC, BASE + DEC]), S_OK);
    assert.equal(m.call('VarDecFix', [BASE + DEC, BASE + DEC]), S_OK);
    assert.equal(m.call('VarDecRound', [BASE + DEC, 0, BASE + DEC]), S_OK);
    assert.equal(m.call('VarI4FromDec', [BASE + DEC, BASE + OUT]), S_OK);
    assert.equal(m.view.getInt32(OUT, true), 2468);
    for (const [i, c] of [...'42', '\0'].entries())
    {
        m.view.setUint16(TEXT + i * 2, c.charCodeAt(0), true);
    }
    assert.equal(m.call('VarR8FromStr', [BASE + TEXT, 0x409, 0, BASE + OUT]), S_OK);
    assert.equal(m.view.getFloat64(OUT, true), 42);
    assert.equal(m.call('VarCyFromI4', [7, BASE + OUT]), S_OK);
    assert.equal(m.view.getBigInt64(OUT, true), 70000n);
});

test('a BSTR made through an out pointer is written whole, eight bytes of it', ()=>{
    const m = setup();
    m.bytes.fill(0xdd, OUT, OUT + 8);
    assert.equal(m.call('VarBstrFromI4', [42, 0x409, 0, BASE + OUT]), S_OK);
    const bstr = m.quad(OUT);
    assert.ok(bstr > 2 ** 32, `0x${bstr.toString(16)}`);
    assert.equal(m.view.getUint16(bstr - BASE, true), '4'.charCodeAt(0));
    m.bytes.fill(0xdd, OUT, OUT + 8);
    assert.equal(m.call('VarBstrFromBool', [1, 0x409, 0, BASE + OUT]), S_OK);
    assert.ok(m.quad(OUT) > 2 ** 32);
    m.view.setUint16(VARIANT, VT_I4, true);
    m.view.setInt32(VARIANT + 8, 5, true);
    m.bytes.fill(0xdd, OUT, OUT + 8);
    assert.equal(m.call('VarFormatNumber', [BASE + VARIANT, -1, -2, -2, -2, 0, BASE + OUT]),
        S_OK);
    assert.ok(m.quad(OUT) > 2 ** 32, 'VarFormatNumber\'s too');
});

test('a string and a month table handed out through a slot are whole', ()=>{
    const m = setup();
    for (const [i, c] of [...'abc', '\0'].entries())
    {
        m.view.setUint16(TEXT + i * 2, c.charCodeAt(0), true);
    }
    m.view.setBigUint64(OUT, 0n, true);
    assert.equal(m.call('SysReAllocString', [BASE + OUT, BASE + TEXT]), 1);
    const bstr = m.quad(OUT);
    assert.ok(bstr > 2 ** 32);
    assert.equal(m.view.getUint32(bstr - BASE - 4, true), 6, 'its prefix, where it is');
    m.bytes.fill(0xdd, OUT, OUT + 8);
    assert.equal(m.call('GetAltMonthNames', [0x419, BASE + OUT]), S_OK);
    const table = m.quad(OUT);
    assert.ok(table > 2 ** 32 && m.quad(table - BASE + 8) > 2 ** 32,
        'the table and its second name, eight bytes each');
    m.bytes.fill(0xdd, OUT, OUT + 8);
    assert.equal(m.call('GetAltMonthNames', [0x409, BASE + OUT]), S_OK);
    assert.equal(m.quad(OUT), 0, 'English has none: NULL, all eight bytes');
});
