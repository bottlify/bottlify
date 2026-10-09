/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrypt32Functions } from './functions.js';

const ERROR_INVALID_PARAMETER = 87;
const NTE_BAD_DATA = 0x80090005;

const IN = 0x100;
const OUT = 0x110;
const BACK = 0x120;
const ENTROPY = 0x130;
const DESCRIPTION_OUT = 0x140;
const DESCRIPTION = 0x200;
const DATA = 0x300;
const SALT = 0x380;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    let next = 0x4000;
    const fns = createCrypt32Functions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        setLastError: code=>errors.push(code),
        localAlloc: size=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
    });
    /** @param {number} at @param {number} address @param {Uint8Array} data */
    const blob = (at, address, data)=>{
        bytes.set(data, address);
        view.setUint32(at, data.length, true);
        view.setUint32(at + 4, address, true);
    };
    /** @param {number} at */
    const readBlob = at=>bytes.slice(view.getUint32(at + 4, true),
        view.getUint32(at + 4, true) + view.getUint32(at, true));
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + text.length * 2, 0, true);
    };
    return { bytes, view, errors, fns, blob, readBlob, wide };
}

test('CryptUnprotectData gives back what CryptProtectData sealed, with its description', ()=>{
    const { view, fns, blob, readBlob, wide, errors } = setup();
    const secret = new TextEncoder().encode('password');
    blob(IN, DATA, secret);
    blob(ENTROPY, SALT, new Uint8Array([1, 2, 3]));
    wide(DESCRIPTION, 'login');
    assert.equal(fns.CryptProtectData.handler([IN, DESCRIPTION, ENTROPY, 0, 0, 0, OUT]), 1);
    assert.notDeepEqual(readBlob(OUT), secret, 'the blob is not the plain data');

    assert.equal(fns.CryptUnprotectData.handler([OUT, DESCRIPTION_OUT, ENTROPY, 0, 0, 0, BACK]), 1);
    assert.deepEqual(readBlob(BACK), secret);
    const description = view.getUint32(DESCRIPTION_OUT, true);
    const units = [];
    for (let at = description; view.getUint16(at, true) !== 0; at += 2)
    {
        units.push(view.getUint16(at, true));
    }
    assert.equal(String.fromCharCode(...units), 'login');
    assert.deepEqual(errors, []);
});

test('CryptUnprotectData refuses the wrong entropy, or bytes not a blob, with NTE_BAD_DATA', ()=>{
    const { fns, blob, errors } = setup();
    blob(IN, DATA, new Uint8Array([9, 9]));
    blob(ENTROPY, SALT, new Uint8Array([1]));
    assert.equal(fns.CryptProtectData.handler([IN, 0, ENTROPY, 0, 0, 0, OUT]), 1);
    assert.equal(fns.CryptUnprotectData.handler([OUT, 0, 0, 0, 0, 0, BACK]), 0);
    assert.equal(fns.CryptUnprotectData.handler([IN, 0, 0, 0, 0, 0, BACK]), 0);
    assert.deepEqual(errors, [NTE_BAD_DATA, NTE_BAD_DATA]);
});

test('a NULL input or output blob is ERROR_INVALID_PARAMETER', ()=>{
    const { fns, blob, errors } = setup();
    blob(IN, DATA, new Uint8Array([1]));
    assert.equal(fns.CryptProtectData.handler([0, 0, 0, 0, 0, 0, OUT]), 0);
    assert.equal(fns.CryptProtectData.handler([IN, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(fns.CryptUnprotectData.handler([IN, 0, 0, 0, 0, 0, 0]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER,
        ERROR_INVALID_PARAMETER]);
});
