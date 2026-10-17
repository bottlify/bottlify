/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The printf family in the guest: its x86 answers as its JavaScript, input by
 * input, on cork's test machine; and its JavaScript renders what the host's
 * printer (`format.js`) renders, for random formats of every flag, width,
 * precision, modifier and conversion it takes -- the gate -- the text, its
 * length and what %n wrote, byte for byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-print.x86.js';
import * as sources from './inguest-print.js';
import { formatToString } from './format.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources);
/** The host's printer, as a stand-in: an answer of its own, nothing written. */
const HANDED = { host: ()=>0x7ffffff0 };

const FORMAT = DATA;
const LIST = DATA + 0x200;
const STRINGS = DATA + 0x400;
const COUNTS = DATA + 0x600;
const BUFFER = DATA + 0x800;
const SIZE = 0xa00;

const TEXTS = ['', 'a', 'Hello', 'path\\to\\file.dds', '\xe9t\xe9', 'x'.repeat(40)];

/** An integer of every size and sign. @param {() => number} next */
const integerOf = next=>[0, 1, 7, 255, 0x7fffffff, 0x80000000, 0xffffffff, 0x10000, 0x8000,
    123456789, next(), -(next() % 1000) >>> 0][next() % 12];

/**
 * A random format, its pieces each from what msvcrt takes, and the va_list's
 * slots it reads: an integer for '*', a string or null for %s, a count's place
 * or null for %n, an integer for the rest.
 *
 * @param {() => number} next
 * @returns {{ format: string, slots: number[] }}
 */
function caseOf(next){
    let format = '';
    /** @type {number[]} */
    const slots = [];
    const pieces = 1 + next() % 5;
    for (let p = 0; p < pieces; p++)
    {
        if (next() % 3 === 0)
        {
            format += ['abc', ' ', '=', 'É', '%%'][next() % 5];
            continue;
        }
        format += '%';
        for (let f = next() % 3; f > 0; f--)
        {
            format += '-0+ #'[next() % 5];
        }
        const width = next() % 5;
        if (width === 1 || width === 2)
        {
            slots.push([5, -3, 0, 12, -1, 40][next() % 6] >>> 0);
        }
        format += width === 0 ? '' : width === 1 ? '*' : width === 2 ? '*1'
            : String(next() % 14);
        const precision = next() % 5;
        if (precision === 2)
        {
            slots.push([3, -2, 0, 9][next() % 4] >>> 0);
        }
        format += precision === 0 ? '' : precision === 1 ? '.' : precision === 2 ? '.*'
            : `.${next() % 12}`;
        const modifier = ['', '', 'h', 'l', 'hh', 'I32', 'I', 'z', 't', 'F', 'N', 'hl', 'll',
            'I64', 'w'][next() % 15];
        format += modifier;
        let conversion = 'diouxXcspn%diouxXsCSaIyq'[next() % 24];
        if (['I', 'z', 't'].includes(modifier) && !'diouxX'.includes(conversion))
        {
            // Before anything but an integer the letter is itself the conversion, one msvcrt
            // does not know: what follows it is a letter of the text, never a '%'.
            conversion = 'q';
        }
        format += conversion;
        if (conversion === 'q')
        {
            // No argument.
        }
        else if (['ll', 'I64'].includes(modifier) && 'diouxX'.includes(conversion))
        {
            slots.push(integerOf(next), integerOf(next));
        }
        else if ('sS'.includes(conversion))
        {
            slots.push(next() % 5 === 0 ? 0 : STRINGS + 64 * (next() % TEXTS.length));
        }
        else if (conversion === 'n')
        {
            slots.push(next() % 5 === 0 ? 0 : COUNTS + 4 * (next() % 8));
        }
        else if ('diouxXcCp'.includes(conversion))
        {
            slots.push(integerOf(next));
        }
    }
    return { format, slots };
}

/** The memory of a case: the format, the list, the strings. @param {string} format @param {number[]} slots */
function memoryOf(format, slots){
    const bytes = new Uint8Array(SIZE);
    const view = new DataView(bytes.buffer);
    [...format, '\0'].forEach((c, i)=>{
        bytes[FORMAT - DATA + i] = c.charCodeAt(0);
    });
    slots.forEach((slot, i)=>view.setUint32(LIST - DATA + 4 * i, slot >>> 0, true));
    TEXTS.forEach((text, k)=>[...text, '\0'].forEach((c, i)=>{
        bytes[STRINGS - DATA + 64 * k + i] = c.charCodeAt(0);
    }));
    return bytes;
}

test('the printers in the guest answer, write and count as their JavaScript', ()=>{
    const next = random(41);
    for (let round = 0; round < 300; round++)
    {
        const { format, slots } = caseOf(next);
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, memoryOf(format, slots)]]);
        const count = [0, 1, 5, 16, 200][next() % 5];
        same('vsprintf', { stack: [BUFFER, FORMAT, LIST], memory }, HANDED);
        same('_vsnprintf', { stack: [BUFFER, count, FORMAT, LIST], memory }, HANDED);
        same('_vscprintf', { stack: [FORMAT, LIST], memory }, HANDED);
        same('_vsnprintf_s', { stack: [BUFFER, [1, 8, 64, 300][next() % 4],
            [0xffffffff, 0, 7, 100][next() % 4], FORMAT, LIST], memory }, HANDED);
    }
});

test('printInto renders what the host\'s printer renders: the text, its length and %n',
    ()=>{
        const next = random(43);
        let rendered = 0;
        for (let round = 0; round < 6000; round++)
        {
            const { format, slots } = caseOf(next);
            const guestMemory = memoryOf(format, slots);
            const hostMemory = guestMemory.slice();
            const view = new DataView(guestMemory.buffer);
            const at = (/** @type {number} */ address)=>address - DATA;
            const helpers = {
                u8: (/** @type {number} */ a)=>guestMemory[at(a)],
                u32: (/** @type {number} */ a)=>view.getUint32(at(a), true),
                setU8: (/** @type {number} */ a, /** @type {number} */ v)=>{
                    guestMemory[at(a)] = v;
                },
                setU32: (/** @type {number} */ a, /** @type {number} */ v)=>
                    view.setUint32(at(a), v >>> 0, true),
            };
            if (sources.formatInGuest(helpers, FORMAT) === 0)
            {
                continue;
            }
            rendered++;
            const total = sources.printInto(helpers, BUFFER, 0x180, FORMAT, LIST, 1);
            const hostView = new DataView(hostMemory.buffer);
            const text = formatToString(format, slots.map(slot=>slot | 0), pointer=>{
                let end = at(pointer);
                while (hostMemory[end] !== 0)
                {
                    end++;
                }
                return String.fromCharCode(...hostMemory.subarray(at(pointer), end));
            }, {
                cLocale: true,
                writeCount: (pointer, value)=>{
                    if (pointer !== 0)
                    {
                        hostView.setInt32(at(pointer), value, true);
                    }
                },
            });
            const label = `round ${round}: ${JSON.stringify(format)}`;
            assert.equal(total, text.length, `${label}: the length`);
            assert.equal(String.fromCharCode(...guestMemory.subarray(at(BUFFER),
                at(BUFFER) + Math.min(total, 0x180))), text.slice(0, 0x180), `${label}: the text`);
            assert.deepEqual([...guestMemory.subarray(at(COUNTS), at(COUNTS) + 32)],
                [...hostMemory.subarray(at(COUNTS), at(COUNTS) + 32)], `${label}: what %n wrote`);
        }
        assert.ok(rendered > 2000, `${rendered} formats rendered in the guest`);
    });
