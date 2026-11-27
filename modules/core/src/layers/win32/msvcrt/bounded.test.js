/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWideFunctions } from './mbstring.js';
import { createSecureFunctions } from './secure.js';
import { createStringFunctions } from './strings.js';
import { fakeMemory } from './harness.test.js';

/**
 * The n-bounded string calls read a string no further than their count, the
 * first two characters that differ, or its terminator: a string that runs to
 * the end of its region, unterminated, is compared, copied and appended
 * without a fault, as on Windows.
 */

/** Where the region ends: a read reaching past it faults, as the memory layer's does. */
const FENCE = 0x20000;

const build = ()=>{
    const memory = fakeMemory();
    const fenced = {
        ...memory,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            if (address + length > FENCE)
            {
                throw new Error(`Unmapped read at 0x${address.toString(16)} (${length} bytes)`);
            }
            return memory.readMemory(address, length);
        },
        /** @param {number} address @param {number} limit */
        readCString: (address, limit)=>{
            const end = memory.bytes.indexOf(0, address);
            if (end === -1 || end >= FENCE)
            {
                throw new Error(`Unmapped read at 0x${FENCE.toString(16)}`);
            }
            return memory.readCString(address, limit);
        },
    };
    /** Units at the very end of the region, no terminator after them. @param {string} text */
    const atEnd = (text, unit = 2)=>{
        const at = FENCE - text.length * unit;
        for (let i = 0; i < text.length; i++)
        {
            memory.bytes[at + i * unit] = text.charCodeAt(i);
            if (unit === 2)
            {
                memory.bytes[at + i * 2 + 1] = 0;
            }
        }
        return at;
    };
    const errno = /** @type {number[]} */ ([]);
    return {
        memory, atEnd,
        wide: /** @type {Record<string, any>} */ (createWideFunctions(fenced)),
        narrow: /** @type {Record<string, any>} */ (createStringFunctions(fenced)),
        secure: /** @type {Record<string, any>} */ (createSecureFunctions({
            ...fenced, errno: code=>errno.push(code),
        })),
    };
};

test('wcsncmp and _wcsnicmp stop at the count and at the first difference', ()=>{
    const { memory, atEnd, wide } = build();
    const edge = atEnd('abcdef');
    assert.equal(wide.wcsncmp.handler([edge, memory.putWide('abcdef'), 6]), 0,
        'equal for the whole count, read no further');
    assert.equal(wide.wcsncmp.handler([edge, memory.putWide('abX'), 100]), 1,
        'a difference ends it, whatever the count');
    assert.equal(wide.wcsncmp.handler([memory.putWide('abX'), edge, 100]), -1);
    assert.equal(wide._wcsnicmp.handler([edge, memory.putWide('ABCDEF'), 6]), 0);
    assert.equal(wide._wcsnicmp.handler([edge, memory.putWide('ABD'), 100]), -1);
    assert.equal(wide.wcsncmp.handler([edge, edge, 0]), 0, 'a count of none reads nothing');
});

test('wcsncpy and wcsncat take no more of the source than the count', ()=>{
    const { memory, atEnd, wide } = build();
    const edge = atEnd('xyz');
    const destination = memory.allocate(32);
    wide.wcsncpy.handler([destination, edge, 3]);
    assert.equal(memory.wide(destination, 3), 'xyz');
    memory.writeMemory(destination, new Uint8Array(32));
    memory.writeMemory(destination, Uint8Array.of(0x41, 0, 0, 0));
    wide.wcsncat.handler([destination, edge, 3]);
    assert.equal(memory.wide(destination), 'Axyz');
});

test('strncat takes no more of the source than the count', ()=>{
    const { memory, atEnd, narrow } = build();
    const edge = atEnd('tail', 1);
    const destination = memory.put('head\0\0\0\0\0\0');
    narrow.strncat.handler([destination, edge, 4]);
    assert.equal(memory.text(destination), 'headtail');
});

test('strncpy_s and wcsncpy_s read a source no further than the count', ()=>{
    const { memory, atEnd, secure } = build();
    const destination = memory.allocate(32);
    assert.equal(secure.strncpy_s.handler([destination, 32, atEnd('abc', 1), 3]), 0);
    assert.equal(memory.text(destination), 'abc');
    assert.equal(secure.wcsncpy_s.handler([destination, 16, atEnd('abc'), 3]), 0);
    assert.equal(memory.wide(destination), 'abc');
});
