/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The secure copies and appends in the guest (`inguest.js`): their x86 and
 * x86-64 answer as their JavaScript, and that JavaScript -- the copy that
 * fits, every refusal handed to the handler -- answers, writes and sets
 * errno as the handlers alone do (`secure.js`, `inGuest: false`), for
 * seeded strings, sizes, counts, missing pointers and overlaps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { createSecureFunctions } from './secure.js';
import { fakeMemory } from './harness.test.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);

const TRUNCATE = 0xffffffff;
const NAMES = ['strcpy_s', 'strcat_s', 'strncpy_s', 'strncat_s', 'wcscpy_s', 'wcscat_s',
    'wcsncpy_s', 'wcsncat_s', 'memcpy_s', 'memmove_s'];

/**
 * A case: the bytes of a region, and the arguments of a call into it -- a
 * destination with or without a terminator within the size, a source of a
 * few units, the source sometimes just ahead of or behind the destination.
 *
 * @param {() => number} next @param {string} name
 */
function caseOf(next, name){
    const unit = name.startsWith('wcs') ? 2 : 1;
    const region = new Uint8Array(0x200);
    for (let i = 0; i < region.length; i++)
    {
        region[i] = next() % 4 === 0 ? 0 : 0x41 + next() % 26;
    }
    const sourceLength = next() % 12;
    const source = 0x40 + unit * (next() % 16);
    for (let i = 0; i < sourceLength * unit; i++)
    {
        region[source + i] = unit === 2 && i % 2 === 1 ? next() % 3 : 0x61 + next() % 26;
    }
    region.fill(0, source + sourceLength * unit, source + sourceLength * unit + unit);
    const shift = [0, 0x100, -0x30, unit, 2 * unit, -unit, 3 * unit, 0][next() % 8];
    const destination = (source + shift) >>> 0;
    const existing = next() % 6;
    if (next() % 4 !== 0 && shift >= 0x100)
    {
        region.fill(0, destination + existing * unit, destination + existing * unit + unit);
    }
    // A size past the string, but not past memory: a handler writes at its end.
    const size = [0, 1, sourceLength, sourceLength + 1, existing + sourceLength + 1, 8, 64,
        0x8000][next() % 8];
    // A copy of memory is as long as its count: never _TRUNCATE's four gigabytes.
    const count = name.startsWith('mem') ? [0, 1, sourceLength, 9, 3, 64, 100][next() % 7]
        : [0, 1, sourceLength, sourceLength + 1, 3, TRUNCATE, 100][next() % 7];
    const at = (/** @type {number} */ offset)=>(next() % 12 === 0 ? 0 : DATA + offset);
    return { region, args: [at(destination), size, at(source), count] };
}

test('the secure copies\' x86 and x86-64 answer as their JavaScript', ()=>{
    const handed = { host: ()=>0x5eed };
    for (const name of NAMES)
    {
        const next = random(name.length * 31 + name.charCodeAt(3));
        for (let i = 0; i < 300; i++)
        {
            const { region, args } = caseOf(next, name);
            const stack = name.includes('n') && !name.startsWith('mem') || name.startsWith('mem')
                ? args : args.slice(0, 3);
            same(name, { stack, memory: [[DATA, [...region]]] }, handed);
        }
    }
});

test('the secure copies in the guest answer, write and set errno as the handlers alone do', ()=>{
    for (const name of NAMES)
    {
        const next = random(name.length * 17 + name.charCodeAt(4));
        let inGuest = 0;
        for (let i = 0; i < 600; i++)
        {
            const { region, args } = caseOf(next, name);
            const counted = name.includes('n') && !name.startsWith('mem') || name.startsWith('mem');
            const call = counted ? args : args.slice(0, 3);
            /** @param {boolean} guest */
            const runOn = guest=>{
                const memory = fakeMemory();
                memory.bytes.set(region, DATA);
                /** @type {number[]} */
                const errno = [];
                let handed = 0;
                const table = /** @type {Record<string, any>} */ (createSecureFunctions({
                    ...memory, errno: code=>errno.push(code),
                }, { inGuest: guest }));
                const fn = table[name];
                const answer = fn.handler(call.map(value=>value | 0)) >>> 0;
                if (errno.length > 0)
                {
                    handed = 1;
                }
                return { answer, errno, bytes: [...memory.bytes.subarray(DATA, DATA + 0x200)],
                    handed };
            };
            const guest = runOn(true);
            const host = runOn(false);
            const label = `${name} case ${i}: ${JSON.stringify(call)}`;
            assert.equal(guest.answer, host.answer, `${label}: the answer`);
            assert.deepEqual(guest.errno, host.errno, `${label}: errno`);
            assert.deepEqual(guest.bytes, host.bytes, `${label}: memory`);
            if (host.errno.length === 0)
            {
                inGuest++;
            }
        }
        assert.ok(inGuest > 50, `${name}: ${inGuest} calls that succeed`);
    }
});
