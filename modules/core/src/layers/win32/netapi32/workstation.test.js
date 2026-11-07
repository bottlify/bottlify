/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * NetWkstaGetInfo against Wine's netapi32 wksta.c expectations: the machine's
 * own name, its workgroup and the system's version in one buffer the caller
 * frees with NetApiBufferFree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkstationFunctions } from './workstation.js';

const NERR_SUCCESS = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BAD_NETPATH = 53;
const ERROR_INVALID_LEVEL = 124;
const OUT = 0x100;
const NAME = 0x200;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Set<number>} */
    const held = new Set();
    let next = 0x1000;
    const fns = /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */ (
        createWorkstationFunctions({
            readMemory: (address, length)=>bytes.slice(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            allocate: size=>{
                const at = next;
                next += (size + 15) & ~15;
                held.add(at);
                return at;
            },
            release: address=>{
                assert.ok(held.delete(address), 'only what was handed out is given back');
            },
            computerName: 'BOTTLIFY',
            version: { major: 6, minor: 1 },
        }));
    /** @param {number} at */
    const wide = at=>{
        let text = '';
        for (let place = at; view.getUint16(place, true) !== 0; place += 2)
        {
            text += String.fromCharCode(view.getUint16(place, true));
        }
        return text;
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        [...text, '\0'].forEach((character, index)=>
            view.setUint16(at + index * 2, character.charCodeAt(0), true));
    };
    return { fns, view, held, wide, putWide };
}

test('level 100 is the platform, the name, the workgroup and the system\'s version', ()=>{
    const { fns, view, held, wide } = setup();
    assert.equal(fns.NetWkstaGetInfo.argBytes, 12);
    assert.equal(fns.NetWkstaGetInfo.handler([0, 100, OUT]), NERR_SUCCESS);
    const info = view.getUint32(OUT, true);
    assert.ok(held.has(info), 'one buffer, handed out');
    assert.equal(view.getUint32(info, true), 500, 'PLATFORM_ID_NT');
    assert.equal(wide(view.getUint32(info + 4, true)), 'BOTTLIFY');
    assert.equal(wide(view.getUint32(info + 8, true)), 'WORKGROUP');
    assert.deepEqual([view.getUint32(info + 12, true), view.getUint32(info + 16, true)], [6, 1]);
    assert.equal(fns.NetApiBufferFree.handler([info]), NERR_SUCCESS);
    assert.equal(held.size, 0);
    assert.equal(fns.NetApiBufferFree.handler([0]), NERR_SUCCESS, 'NULL is nothing to free');
});

test('levels 101 and 102 add the LAN root and the users logged on; others are refused', ()=>{
    const { fns, view, wide } = setup();
    assert.equal(fns.NetWkstaGetInfo.handler([0, 102, OUT]), NERR_SUCCESS);
    const info = view.getUint32(OUT, true);
    assert.equal(wide(view.getUint32(info + 20, true)), '', 'no LAN root');
    assert.equal(view.getUint32(info + 24, true), 1, 'the one user');
    assert.equal(fns.NetWkstaGetInfo.handler([0, 101, OUT]), NERR_SUCCESS);
    assert.equal(fns.NetWkstaGetInfo.handler([0, 99, OUT]), ERROR_INVALID_LEVEL);
    assert.equal(fns.NetWkstaGetInfo.handler([0, 100, 0]), ERROR_INVALID_PARAMETER);
});

test('the machine named by its own name is this one, any other is not on a network here', ()=>{
    const { fns, putWide } = setup();
    putWide(NAME, '\\\\bottlify');
    assert.equal(fns.NetWkstaGetInfo.handler([NAME, 100, OUT]), NERR_SUCCESS);
    putWide(NAME, '\\\\OTHER');
    assert.equal(fns.NetWkstaGetInfo.handler([NAME, 100, OUT]), ERROR_BAD_NETPATH);
});

test('a buffer allocated is sized and freed', ()=>{
    const { fns, view, held } = setup();
    assert.equal(fns.NetApiBufferAllocate.handler([40, OUT]), NERR_SUCCESS);
    const buffer = view.getUint32(OUT, true);
    assert.equal(fns.NetApiBufferSize.handler([buffer, OUT + 4]), NERR_SUCCESS);
    assert.equal(view.getUint32(OUT + 4, true), 40);
    assert.equal(fns.NetApiBufferFree.handler([buffer]), NERR_SUCCESS);
    assert.equal(held.size, 0);
    assert.equal(fns.NetApiBufferSize.handler([buffer, OUT + 4]), ERROR_INVALID_PARAMETER);
});
