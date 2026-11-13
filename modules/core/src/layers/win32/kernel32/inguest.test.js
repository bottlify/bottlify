/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * kernel32's functions in the guest (`inguest.js`). MultiByteToWideChar and
 * WideCharToMultiByte: the x86 answers as
 * its JavaScript on cork's test machine, case by case, and - the gate - the
 * export with its guest path answers every call as the host's handler alone
 * does: the result, the last error, and every byte of memory, over random
 * pages, flags, lengths, texts with and without a unit past ASCII, and
 * destinations missing, measuring, too small and large enough.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { createLocaleFunctions } from './locale.js';
import { conversionsInGuest } from '../module.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);
/** The host's stand-in: here only that it was reached. */
const HANDED = { host: ()=>0x5157 };

const PAGES = [0, 1252, 65001, 3, 437, 932, 1200];
const MB_FLAGS = [0, 0, 0, 1, 8, 9, 2, 4, 0x10];
const WC_FLAGS = [0, 0, 0, 0x400, 0x200, 0x80, 0x40, 0x10, 0x20, 0x800, 1];

/**
 * A text of units, mostly ASCII, now and then one past it.
 *
 * @param {() => number} next @param {number} length @param {number} wide  the
 *     largest unit past ASCII
 */
const units = (next, length, wide)=>Array.from({ length }, ()=>(next() < 0.04
    ? 0x80 + Math.floor(next() * (wide - 0x80)) : 1 + Math.floor(next() * 0x7f)));

/**
 * One random call of each: its arguments, and the bytes at the source.
 *
 * @param {() => number} next
 * @param {number} source @param {number} destination @param {number} used
 */
const randomCall = (next, source, destination, used)=>{
    const length = Math.floor(next() * 40);
    const pick = (/** @type {number[]} */ list)=>list[Math.floor(next() * list.length)];
    const terminated = next() < 0.5;
    const declared = terminated ? (next() < 0.8 ? -1 : -2 - Math.floor(next() * 5))
        : next() < 0.05 ? 0 : length;
    const room = next() < 0.3 ? 0 : next() < 0.15 ? -1
        : Math.max(0, length + 1 + Math.floor(next() * 6) - 4);
    return {
        page: pick(PAGES), length, declared, room,
        mbFlags: pick(MB_FLAGS), wcFlags: pick(WC_FLAGS),
        source: next() < 0.03 ? 0 : source,
        destination: next() < 0.06 ? 0 : destination,
        used: next() < 0.3 ? used : 0,
    };
};

test('each conversion\'s x86 answers and writes as its JavaScript', ()=>{
    const next = (()=>{
        const words = random(41);
        return ()=>words() / 2 ** 32;
    })();
    const SOURCE = DATA + 0x100;
    const OUT = DATA + 0x400;
    const USED = DATA + 0x800;
    for (let round = 0; round < 600; round++)
    {
        const call = randomCall(next, SOURCE, OUT, USED);
        const narrow = units(next, call.length, 0x100);
        same('MultiByteToWideChar', {
            stack: [call.page, call.mbFlags, call.source, call.declared, call.destination,
                call.room],
            memory: [[SOURCE, [...narrow, 0]]],
        }, HANDED);
        const wide = units(next, call.length, 0x10000);
        same('WideCharToMultiByte', {
            stack: [call.page, call.wcFlags, call.source, call.declared, call.destination,
                call.room, 0, call.used],
            memory: [[SOURCE, [...wide, 0].flatMap(unit=>[unit & 0xff, unit >> 8])],
                [USED, [0xaa, 0xaa, 0xaa, 0xaa]]],
        }, HANDED);
    }
});

test('FlushInstructionCache answers TRUE in the guest, as its handler does', ()=>{
    for (const stack of [[0xffffffff, 0x401000, 0x100], [0, 0, 0], [0x44, 0x7ffe0000, 1]])
    {
        assert.equal(same('FlushInstructionCache', { stack }).eax, 1);
    }
});

/**
 * The locale functions over a memory of their own.
 *
 * @param {boolean} guestCode
 */
const machine = guestCode=>{
    const bytes = new Uint8Array(0x2000);
    /** @type {number[]} */
    const errors = [];
    const readMemory = (/** @type {number} */ at, /** @type {number} */ length)=>{
        if (at < 0x10 || at + length > bytes.length)
        {
            throw new Error(`a read at 0x${at.toString(16)}`);
        }
        return bytes.slice(at, at + length);
    };
    const writeMemory = (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>{
        bytes.set(data, at);
    };
    const table = createLocaleFunctions(/** @type {any} */ ({
        readMemory, writeMemory,
        stringLength: (/** @type {number} */ at, /** @type {number} */ unit)=>{
            let count = 0;
            while ((unit === 1 ? bytes[at + count]
                : bytes[at + count * 2] | bytes[at + count * 2 + 1]) !== 0)
            {
                count++;
            }
            return count;
        },
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    }));
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        guestCode ? conversionsInGuest(table, { readMemory, writeMemory }) : table);
    return { bytes, errors, fns };
};

test('the gate: with its guest path, each conversion answers every call as the host alone', ()=>{
    const next = (()=>{
        const words = random(43);
        return ()=>words() / 2 ** 32;
    })();
    const SOURCE = 0x100;
    const OUT = 0x400;
    const USED = 0x800;
    let inGuest = 0;
    for (let round = 0; round < 4000; round++)
    {
        const call = randomCall(next, SOURCE, OUT, USED);
        const both = [machine(true), machine(false)];
        const multi = next() < 0.5;
        const text = units(next, call.length, multi ? 0x100 : 0x10000);
        for (const { bytes } of both)
        {
            bytes.fill(0xcc, OUT, OUT + 0x200);
            bytes.fill(0xaa, USED, USED + 4);
            text.concat(0).forEach((unit, at)=>{
                if (multi)
                {
                    bytes[SOURCE + at] = unit;
                }
                else
                {
                    bytes[SOURCE + at * 2] = unit & 0xff;
                    bytes[SOURCE + at * 2 + 1] = unit >> 8;
                }
            });
        }
        const args = multi
            ? [call.page, call.mbFlags, call.source, call.declared, call.destination, call.room]
            : [call.page, call.wcFlags, call.source, call.declared, call.destination, call.room,
                0, call.used];
        const name = multi ? 'MultiByteToWideChar' : 'WideCharToMultiByte';
        const [guest, host] = both.map(({ fns })=>fns[name].handler([...args]));
        const what = `${name}(${args.join(', ')}) over [${text.join(', ')}]`;
        assert.equal(guest, host, `${what}: the answer`);
        assert.deepEqual(both[0].errors, both[1].errors, `${what}: the last error`);
        assert.deepEqual(both[0].bytes, both[1].bytes, `${what}: memory`);
        inGuest += both[0].errors.length === 0 && guest > 0 && text.every(unit=>unit < 0x80)
            ? 1 : 0;
    }
    assert.ok(inGuest > 400, `the guest path answered ${inGuest} of the calls`);
});
