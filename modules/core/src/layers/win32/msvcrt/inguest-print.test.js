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
 * length and what %n wrote, byte for byte. Its x86-64 answers as its
 * JavaScript run with pointers of eight bytes, the same cases laid out as a
 * 64-bit `va_list` is: slots of eight bytes, an integer's upper half
 * whatever the caller left there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-print.x86.js';
import { COMPILED as LONG } from './inguest-print.x64.js';
import * as sources from './inguest-print.js';
import { formatToString } from './format.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';

// The i386 alone, on 4-byte slots; the x86-64 apart, on its own layout.
const { same } = equivalence(COMPILED, sources, undefined, {});
const { sameAt64 } = equivalence(COMPILED, sources, undefined, LONG);
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

/**
 * The memory of a case: the format, the list, the strings. A slot of eight
 * bytes holds a pointer whole and an integer in its lower half, the upper
 * one left as a caller may leave it.
 *
 * @param {string} format @param {number[]} slots @param {number} [slotBytes]
 */
function memoryOf(format, slots, slotBytes = 4){
    const bytes = new Uint8Array(SIZE);
    const view = new DataView(bytes.buffer);
    [...format, '\0'].forEach((c, i)=>{
        bytes[FORMAT - DATA + i] = c.charCodeAt(0);
    });
    slots.forEach((slot, i)=>{
        view.setUint32(LIST - DATA + slotBytes * i, slot >>> 0, true);
        const pointer = slot === 0 || slot >= DATA && slot < DATA + SIZE;
        if (slotBytes === 8 && !pointer)
        {
            view.setUint32(LIST - DATA + 8 * i + 4, Math.imul(slot, 0x9e3779b1) + i, true);
        }
    });
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
        const size = [1, 8, 64, 300][next() % 4];
        const limit = [0xffffffff, 0, 7, 100][next() % 4];
        same('_vsnprintf_s', { stack: [BUFFER, size, limit, FORMAT, LIST], memory }, HANDED);
        const wide = /** @type {[number, Uint8Array][]} */ ([[DATA, memoryOf(format, slots, 8)]]);
        sameAt64('vsprintf', { stack: [BUFFER, FORMAT, LIST], memory: wide }, HANDED);
        sameAt64('_vsnprintf', { stack: [BUFFER, count, FORMAT, LIST], memory: wide }, HANDED);
        sameAt64('_vscprintf', { stack: [FORMAT, LIST], memory: wide }, HANDED);
        sameAt64('_vsnprintf_s', { stack: [BUFFER, size, limit, FORMAT, LIST], memory: wide },
            HANDED);
        same('vsprintf_s', { stack: [BUFFER, size, FORMAT, LIST], memory }, HANDED);
        sameAt64('vsprintf_s', { stack: [BUFFER, size, FORMAT, LIST], memory: wide }, HANDED);
    }
});

test('the UCRT\'s printers take their options quadword as two slots at 32 bits and one register'
    + ' at 64, and answer as their JavaScript under every behaviour the options pick', ()=>{
    const next = random(44);
    for (let round = 0; round < 300; round++)
    {
        const { format, slots } = caseOf(next);
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, memoryOf(format, slots)]]);
        const wide = /** @type {[number, Uint8Array][]} */ ([[DATA, memoryOf(format, slots, 8)]]);
        // The upper half of the options, and a locale, are whatever the caller left.
        const options = [0, 1, 2, 3][next() % 4];
        const high = next();
        const buffer = next() % 6 === 0 ? 0 : BUFFER;
        const count = [0, 1, 5, 16, 200, 0xffffffff][next() % 6];
        const format_ = next() % 30 === 0 ? 0 : FORMAT;
        for (const name of ['__stdio_common_vsprintf', '__stdio_common_vsprintf_s'])
        {
            same(name, { stack: [options, high, buffer, count, format_, 0x5eed, LIST], memory },
                HANDED);
            sameAt64(name, { stack: [options, buffer, count, format_, 0x5eed, LIST, high],
                memory: wide }, HANDED);
        }
    }
});

test('printInto renders what the host\'s printer renders: the text, its length and %n, on'
    + ' slots of four bytes and of eight', ()=>{
    for (const slotBytes of [4, 8])
    {
        const next = random(43);
        let rendered = 0;
        for (let round = 0; round < 6000; round++)
        {
            const { format, slots } = caseOf(next);
            const guestMemory = memoryOf(format, slots, slotBytes);
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
                pointerBytes: slotBytes,
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
            const label = `${slotBytes}-byte slots, round ${round}: ${JSON.stringify(format)}`;
            assert.equal(total, text.length, `${label}: the length`);
            assert.equal(String.fromCharCode(...guestMemory.subarray(at(BUFFER),
                at(BUFFER) + Math.min(total, 0x180))), text.slice(0, 0x180), `${label}: the text`);
            assert.deepEqual([...guestMemory.subarray(at(COUNTS), at(COUNTS) + 32)],
                [...hostMemory.subarray(at(COUNTS), at(COUNTS) + 32)], `${label}: what %n wrote`);
        }
        assert.ok(rendered > 2000, `${slotBytes}: ${rendered} formats rendered in the guest`);
    }
});

/**
 * The memory of a wide case: the format and the strings in units, the list as
 * `memoryOf` lays it.
 *
 * @param {string} format @param {number[]} slots @param {number} [slotBytes]
 */
function wideMemoryOf(format, slots, slotBytes = 4){
    const bytes = memoryOf('', slots, slotBytes);
    const view = new DataView(bytes.buffer);
    [...format, '\0'].forEach((c, i)=>view.setUint16(FORMAT - DATA + 2 * i, c.charCodeAt(0), true));
    bytes.fill(0, STRINGS - DATA, COUNTS - DATA);
    TEXTS.forEach((text, k)=>[...text, '\0'].forEach((c, i)=>{
        view.setUint16(STRINGS - DATA + 64 * k + 2 * i, c.charCodeAt(0), true);
    }));
    return bytes;
}

test('printIntoWide renders what the host\'s wide printer renders: the text in units, its'
    + ' length and %n, on slots of four bytes and of eight; a narrow string the host\'s', ()=>{
    for (const slotBytes of [4, 8])
    {
        const next = random(45);
        let rendered = 0;
        for (let round = 0; round < 6000; round++)
        {
            const { format, slots } = caseOf(next);
            const guestMemory = wideMemoryOf(format, slots, slotBytes);
            const hostMemory = guestMemory.slice();
            const view = new DataView(guestMemory.buffer);
            const at = (/** @type {number} */ address)=>address - DATA;
            const helpers = {
                u16: (/** @type {number} */ a)=>view.getUint16(at(a), true),
                u32: (/** @type {number} */ a)=>view.getUint32(at(a), true),
                setU16: (/** @type {number} */ a, /** @type {number} */ v)=>
                    view.setUint16(at(a), v, true),
                setU32: (/** @type {number} */ a, /** @type {number} */ v)=>
                    view.setUint32(at(a), v >>> 0, true),
                pointerBytes: slotBytes,
            };
            if (sources.formatInGuestWide(helpers, FORMAT) === 0)
            {
                continue;
            }
            rendered++;
            const total = sources.printIntoWide(helpers, BUFFER, 0x100, FORMAT, LIST, 1);
            const hostView = new DataView(hostMemory.buffer);
            const readWide = (/** @type {number} */ pointer)=>{
                let text = '';
                for (let a = at(pointer); hostView.getUint16(a, true) !== 0; a += 2)
                {
                    text += String.fromCharCode(hostView.getUint16(a, true));
                }
                return text;
            };
            const text = formatToString(format, slots.map(slot=>slot | 0), ()=>{
                throw new Error('a narrow string reached the host in a format the guest took');
            }, {
                cLocale: true,
                wide: true,
                readWideString: readWide,
                writeCount: (pointer, value)=>{
                    if (pointer !== 0)
                    {
                        hostView.setInt32(at(pointer), value, true);
                    }
                },
            });
            const label = `${slotBytes}-byte slots, round ${round}: ${JSON.stringify(format)}`;
            assert.equal(total, text.length, `${label}: the length`);
            const units = [];
            for (let i = 0; i < Math.min(total, 0x100); i++)
            {
                units.push(view.getUint16(at(BUFFER) + 2 * i, true));
            }
            assert.equal(String.fromCharCode(...units), text.slice(0, 0x100), `${label}: the text`);
            assert.deepEqual([...guestMemory.subarray(at(COUNTS), at(COUNTS) + 32)],
                [...hostMemory.subarray(at(COUNTS), at(COUNTS) + 32)], `${label}: what %n wrote`);
        }
        assert.ok(rendered > 1500, `${slotBytes}: ${rendered} formats rendered in the guest`);
    }
});

test('the wide printers in the guest answer, write and count as their JavaScript, the UCRT\'s'
    + ' options two slots at 32 bits and one register at 64', ()=>{
    const next = random(46);
    for (let round = 0; round < 300; round++)
    {
        const { format, slots } = caseOf(next);
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA, wideMemoryOf(format,
            slots)]]);
        const wide = /** @type {[number, Uint8Array][]} */ ([[DATA, wideMemoryOf(format, slots,
            8)]]);
        const buffer = next() % 6 === 0 ? 0 : BUFFER;
        const count = [0, 1, 5, 16, 200, 0xffffffff][next() % 6];
        const size = [1, 8, 64, 200][next() % 4];
        const options = [0, 1, 2, 3][next() % 4];
        const high = next();
        const format_ = next() % 30 === 0 ? 0 : FORMAT;
        same('_vsnwprintf', { stack: [buffer, count, format_, LIST], memory }, HANDED);
        sameAt64('_vsnwprintf', { stack: [buffer, count, format_, LIST], memory: wide }, HANDED);
        same('vswprintf', { stack: [buffer, format_, LIST], memory }, HANDED);
        sameAt64('vswprintf', { stack: [buffer, format_, LIST], memory: wide }, HANDED);
        same('_vscwprintf', { stack: [format_, LIST], memory }, HANDED);
        sameAt64('_vscwprintf', { stack: [format_, LIST], memory: wide }, HANDED);
        same('vswprintf_s', { stack: [buffer, size, format_, LIST], memory }, HANDED);
        sameAt64('vswprintf_s', { stack: [buffer, size, format_, LIST], memory: wide }, HANDED);
        for (const name of ['__stdio_common_vswprintf', '__stdio_common_vswprintf_s'])
        {
            same(name, { stack: [options, high, buffer, count, format_, 0x5eed, LIST], memory },
                HANDED);
            sameAt64(name, { stack: [options, buffer, count, format_, 0x5eed, LIST, high],
                memory: wide }, HANDED);
        }
    }
});
