/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The user-marshal routines in a 64-bit process whose memory lies past 4 GiB,
 * called as the bridge calls them: each address argument whole. The variable
 * a routine is handed is pointer-sized, a STGMEDIUM's union and its
 * pUnkForRelease are at 8 and 16, an SNB's table holds 8-byte pointers, an
 * HGLOBAL in-process goes as WDT_INPROC64_CALL and its value whole (its
 * wire union has an __int64 arm, wtypes.idl), and the buffer's next byte is
 * answered whole.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserMarshalFunctions } from './usrmarshal.js';
import { guestWindow } from '../msvcrt/guest-window.fixture.js';
import { declareAddresses } from '../common/pointers.js';
import { POINTER_ARGUMENTS } from '../common/pointer-arguments.js';
import { wholeAddresses } from '../../bridge/internal/dispatch.js';

const BASE = 0x140000000;
const WDT_INPROC_CALL = 0x48746457;
const WDT_INPROC64_CALL = 0x50746457;
const MSHCTX_INPROC = 3;
const TYMED_HGLOBAL = 1;

/** Offsets in the window. */
const FLAGS = 0x100;
const SLOT = 0x200;
const SLOT2 = 0x220;
const MEDIUM = 0x300;
const MEDIUM2 = 0x340;
const STRINGS = 0x400;
const BUFFER = 0x1000;
const HEAP = 0x8000;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, number>} */
    const blocks = new Map();
    let next = BASE + HEAP;
    const guest = guestWindow(bytes, { base: BASE, pointerSize: 8 });
    const table = createUserMarshalFunctions(/** @type {any} */ ({
        guest,
        heap: {
            /** @param {number} size */
            allocate(size){
                const at = next;
                next += size + 15 & ~15;
                blocks.set(at, size);
                return at;
            },
            /** @param {number} at */
            free: at=>blocks.delete(at),
            /** @param {number} at */
            block: at=>(blocks.has(at) ? { size: /** @type {number} */ (blocks.get(at)) } : null),
        },
        raise: (/** @type {number} */ code)=>{
            throw new Error(`raised ${code}`);
        },
        raiseLater: async(/** @type {number} */ code)=>{
            throw new Error(`raised ${code}`);
        },
    }));
    declareAddresses({ 'ole32.dll': table }, POINTER_ARGUMENTS);
    /**
     * The handler called with each argument as a 64-bit caller passes it,
     * whole where the export declares an address.
     *
     * @param {string} name @param {number[]} words
     */
    const call = (name, words)=>{
        const spec = /** @type {any} */ (table)[name];
        const args = words.map(word=>word % 2 ** 32);
        const high = words.map(word=>Math.floor(word / 2 ** 32));
        wholeAddresses(spec.addresses ?? null, args, high);
        return spec.handler(Object.assign(args, { high }));
    };
    /** @param {number} at */
    const quad = at=>Number(view.getBigUint64(at - BASE, true));
    /** @param {number} at @param {number} value */
    const putQuad = (at, value)=>view.setBigUint64(at - BASE, BigInt(value), true);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at - BASE, true);
    view.setUint32(FLAGS, MSHCTX_INPROC | 0x10 << 16, true);
    return { bytes, view, blocks, call, quad, putQuad, u32, guest, table };
}

test('every routine of a type declares its address arguments, its buffer answered as one', ()=>{
    const { table } = setup();
    const spec = /** @type {Record<string, any>} */ (table);
    for (const type of ['HWND', 'HGLOBAL', 'STGMEDIUM', 'SNB', 'CLIPFORMAT'])
    {
        assert.deepEqual(spec[`${type}_UserSize`].addresses, [0, 2]);
        assert.deepEqual(spec[`${type}_UserMarshal`].addresses, [0, 1, 2]);
        assert.deepEqual(spec[`${type}_UserUnmarshal`].addresses, [0, 1, 2]);
        assert.deepEqual(spec[`${type}_UserFree`].addresses, [0, 1]);
        assert.equal(spec[`${type}_UserMarshal`].returns, 'pointer');
        assert.equal(spec[`${type}_UserUnmarshal`].returns, 'pointer');
    }
});

test('a window handle goes as its dword and comes back into an 8-byte variable', ()=>{
    const m = setup();
    m.putQuad(BASE + SLOT, 0x10022);
    m.putQuad(BASE + SLOT2, 0xdddddddd_dddd);
    assert.equal(m.call('HWND_UserSize', [BASE + FLAGS, 0, BASE + SLOT]), 8);
    assert.equal(m.call('HWND_UserMarshal', [BASE + FLAGS, BASE + BUFFER, BASE + SLOT]),
        BASE + BUFFER + 8, 'the next byte, whole');
    assert.deepEqual([m.u32(BASE + BUFFER), m.u32(BASE + BUFFER + 4)], [WDT_INPROC_CALL, 0x10022]);
    assert.equal(m.call('HWND_UserUnmarshal', [BASE + FLAGS, BASE + BUFFER, BASE + SLOT2]),
        BASE + BUFFER + 8);
    assert.equal(m.quad(BASE + SLOT2), 0x10022, 'all eight bytes of the variable');
});

test('an HGLOBAL in-process is WDT_INPROC64_CALL and its address whole, on 8 bytes', ()=>{
    const m = setup();
    const block = BASE + HEAP + 0x100;
    m.putQuad(BASE + SLOT, block);
    // From an offset of 4, the union starts at 8: tag, pad, the value.
    assert.equal(m.call('HGLOBAL_UserSize', [BASE + FLAGS, 4, BASE + SLOT]), 24);
    assert.equal(m.call('HGLOBAL_UserMarshal', [BASE + FLAGS, BASE + BUFFER + 4, BASE + SLOT]),
        BASE + BUFFER + 24);
    assert.equal(m.u32(BASE + BUFFER + 8), WDT_INPROC64_CALL);
    assert.equal(m.quad(BASE + BUFFER + 16), block);
    assert.equal(m.call('HGLOBAL_UserUnmarshal', [BASE + FLAGS, BASE + BUFFER + 4, BASE + SLOT2]),
        BASE + BUFFER + 24);
    assert.equal(m.quad(BASE + SLOT2), block);
});

test('a STGMEDIUM has its union at 8 and pUnkForRelease at 16', ()=>{
    const m = setup();
    const block = BASE + HEAP + 0x200;
    m.view.setUint32(MEDIUM, TYMED_HGLOBAL, true);
    m.putQuad(BASE + MEDIUM + 8, block);
    m.putQuad(BASE + MEDIUM + 16, 0);
    const end = m.call('STGMEDIUM_UserMarshal', [BASE + FLAGS, BASE + BUFFER, BASE + MEDIUM]);
    assert.deepEqual([m.u32(BASE + BUFFER), m.u32(BASE + BUFFER + 4) !== 0,
        m.u32(BASE + BUFFER + 8)], [TYMED_HGLOBAL, true, 0], 'the tymed and two marks');
    assert.equal(m.u32(BASE + BUFFER + 16), WDT_INPROC64_CALL, 'the HGLOBAL on 8 after them');
    assert.equal(m.call('STGMEDIUM_UserSize', [BASE + FLAGS, 0, BASE + MEDIUM]),
        end - BASE - BUFFER);
    m.bytes.fill(0xdd, MEDIUM2, MEDIUM2 + 16);
    assert.equal(m.call('STGMEDIUM_UserUnmarshal', [BASE + FLAGS, BASE + BUFFER, BASE + MEDIUM2]),
        end);
    assert.deepEqual([m.u32(BASE + MEDIUM2), m.quad(BASE + MEDIUM2 + 8),
        m.quad(BASE + MEDIUM2 + 16)], [TYMED_HGLOBAL, block, 0]);
});

test('an SNB\'s pointers are 8 bytes each, read and made whole', ()=>{
    const m = setup();
    const names = ['one', 'two'];
    let at = STRINGS + 0x40;
    names.forEach((name, index)=>{
        m.putQuad(BASE + STRINGS + index * 8, BASE + at);
        for (const [i, c] of [...name, '\0'].entries())
        {
            m.view.setUint16(at + i * 2, c.charCodeAt(0), true);
        }
        at += 16;
    });
    m.putQuad(BASE + STRINGS + 16, 0);
    m.putQuad(BASE + SLOT, BASE + STRINGS);
    const units = 8;
    assert.equal(m.call('SNB_UserSize', [BASE + FLAGS, 0, BASE + SLOT]), 12 + units * 2);
    const end = m.call('SNB_UserMarshal', [BASE + FLAGS, BASE + BUFFER, BASE + SLOT]);
    assert.equal(end, BASE + BUFFER + 12 + units * 2);
    assert.equal(m.call('SNB_UserUnmarshal', [BASE + FLAGS, BASE + BUFFER, BASE + SLOT2]), end);
    const snb = m.quad(BASE + SLOT2);
    assert.ok(snb > 2 ** 32, 'the block, whole');
    const read = [0, 1].map(index=>m.guest.wstr(m.quad(snb + index * 8)));
    assert.deepEqual(read, names);
    assert.equal(m.quad(snb + 16), 0, 'NULL after them');
});
