/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Part 3 of msvcrt's guest code against its x86; see `inguest.test.js`. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

/**
 * The host's handler, as a multibyte function's case sees it: an answer no
 * guest code gives, and the memory untouched, so a call answered on one side
 * and handed over on the other differs.
 */
const HANDED = { host: ()=>0x5a5a5a5a };

/**
 * ASCII -- letters of both cases, the bytes beside them, a space -- and
 * the bytes past 0x7f a double-byte page leads or trails with.
 *
 * @param {() => number} next
 */
const multiBytes = next=>(/** @type {number} */ length, high = 4)=>Array.from({ length },
    ()=>(next() % 16 < high
        ? [0x80, 0x81, 0x9f, 0xb0, 0xe0, 0xff][next() % 6]
        : [0x41, 0x42, 0x5a, 0x61, 0x62, 0x7a, 0x40, 0x5b, 0x20, 0x31][next() % 10]));

test('the multibyte family answers a string of ASCII itself, and hands the host the calls '
    + 'with a byte past it', ()=>{
    const next = random(22);
    const text = multiBytes(next);
    for (let i = 0; i < 120; i++)
    {
        const ascii = i % 3 === 0;
        /**
         * @param {string} name
         * @param {import('../../../../scripts/guest-code/equivalence.mjs').Case} input
         */
        const check = (name, input)=>{
            const { handedOver } = same(name, input, HANDED);
            assert.ok(!ascii || !handedOver, `${name} answers ASCII itself`);
        };
        const a = [...text(next() % 20, ascii ? 0 : 4), 0];
        const b = next() % 3 === 0 ? [...a] : [...text(next() % 20, ascii ? 0 : 4), 0];
        const memory = /** @type {[number, number[]][]} */ ([[DATA + 0x10, a],
            [DATA + 0x80, b]]);
        for (const name of ['_mbslen', '_mbclen', '_mbsinc', '_mbslwr', '_mbsupr'])
        {
            check(name, { stack: [DATA + 0x10], memory });
        }
        for (const name of ['_mbscmp', '_mbsicmp', '_mbsstr'])
        {
            check(name, { stack: [DATA + 0x10, DATA + 0x80], memory });
        }
        for (const count of [0, 1, 3, a.length, 0xffffffff])
        {
            check('_mbsncmp', { stack: [DATA + 0x10, DATA + 0x80, count], memory });
            check('_mbsnicmp', { stack: [DATA + 0x10, DATA + 0x80, count], memory });
        }
        for (const c of [0, 0x41, 0x61, 0x7f, 0x80, 0xb0, 0x8140, a[next() % a.length]])
        {
            // A character past 0x7f is the host's however plain the string.
            for (const name of ['_mbschr', '_mbsrchr'])
            {
                if (c > 0x7f)
                {
                    same(name, { stack: [DATA + 0x10, c], memory }, HANDED);
                }
                else
                {
                    check(name, { stack: [DATA + 0x10, c], memory });
                }
            }
        }
        for (const [start, at] of [[0x10, 0x10], [0x10, 0x11], [0x10, 0x12],
            [0x10, 0x10 + a.length - 1], [0x11, 0x10]])
        {
            check('_mbsdec', { stack: [DATA + start, DATA + at], memory });
        }
        for (const count of [0, 1, 2, a.length - 1, a.length + 4])
        {
            check('_mbsncpy', { stack: [DATA + 0x100, DATA + 0x10, count], memory });
            check('_mbsncpy', { stack: [DATA + 0x12, DATA + 0x10, count], memory });
            check('_mbsncpy', { stack: [DATA + 0x10, DATA + 0x12, count], memory });
        }
    }
    for (const c of [0, 0x41, 0x7f, 0x80, 0x81, 0xff, 0x1234b0, 0x123420, 0xffffffff])
    {
        same('_ismbblead', { stack: [c] }, HANDED);
    }
    for (const [destination, source] of [[0, DATA], [DATA, 0], [0, 0]])
    {
        same('_mbsncpy', { stack: [destination, source, 1], memory: [[DATA, [0x41, 0]]] },
            HANDED);
        same('_mbsncpy', { stack: [destination, source, 0], memory: [[DATA, [0x41, 0]]] },
            HANDED);
    }
});
