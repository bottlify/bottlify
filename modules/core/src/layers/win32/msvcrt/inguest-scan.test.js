/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * sscanf in the guest - the gate. Its JavaScript answers and stores what the
 * host's scanner (`runScan` behind sscanf's handler) answers and stores, for
 * random formats of every conversion, width and modifier over random inputs,
 * on slots of four bytes and of eight; a call it hands over it has written
 * nothing for; and its x86 and x86-64 answer as its JavaScript, input by
 * input, on cork's test machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-scan.x86.js';
import { COMPILED as LONG } from './inguest-scan.x64.js';
import * as sources from './inguest-scan.js';
import { createScanFunctions, listScanHandler } from './scan.js';
import { guestThrough } from './guest-window.fixture.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { caseOf, pick } from './scan-cases.fixture.js';

const { same } = equivalence(COMPILED, sources, undefined, {});
const { sameAt64 } = equivalence(COMPILED, sources, undefined, LONG);

const FORMAT = DATA;
const INPUT = DATA + 0x100;
const LIST = DATA + 0x300;
const PLACES = DATA + 0x400;
const PLACE_BYTES = 0x40;
const SIZE = 0x1000;

/**
 * The memory of a case: the format, the input, the list of places - a slot
 * in forty a null, one a place over the input, one over the list itself -
 * and the places, filled so that a store of the wrong size shows.
 *
 * @param {string} format @param {string} input @param {() => number} next
 * @param {number} slotBytes
 */
function memoryOf(format, input, next, slotBytes){
    const bytes = new Uint8Array(SIZE).fill(0xcc, PLACES - DATA);
    const view = new DataView(bytes.buffer);
    [...format, '\0'].forEach((c, i)=>{
        bytes[FORMAT - DATA + i] = c.charCodeAt(0);
    });
    [...input, '\0'].forEach((c, i)=>{
        bytes[INPUT - DATA + i] = c.charCodeAt(0);
    });
    for (let i = 0; i < 40; i++)
    {
        const odd = next() % 40;
        const place = odd === 0 ? 0 : odd === 1 ? INPUT + next() % 8 : odd === 2 ? LIST + 2
            : odd === 3 ? FORMAT + 1 : PLACES + PLACE_BYTES * i;
        if (slotBytes * (i + 1) <= PLACES - LIST)
        {
            view.setUint32(LIST - DATA + slotBytes * i, place, true);
            if (slotBytes === 8 && next() % 60 === 0)
            {
                view.setUint32(LIST - DATA + 8 * i + 4, 1, true);
            }
        }
    }
    return bytes;
}

/** The source's helpers over a case's memory. @param {Uint8Array} bytes @param {number} slotBytes */
function helpersOf(bytes, slotBytes){
    const view = new DataView(bytes.buffer);
    const at = (/** @type {number} */ address)=>{
        assert.ok(address >= DATA && address < DATA + SIZE, `0x${address.toString(16)} in reach`);
        return address - DATA;
    };
    let handed = false;
    let word = 0x27f;
    return {
        u8: (/** @type {number} */ a)=>bytes[at(a)],
        u32: (/** @type {number} */ a)=>view.getUint32(at(a), true),
        setU8: (/** @type {number} */ a, /** @type {number} */ v)=>{
            bytes[at(a)] = v;
        },
        setU16: (/** @type {number} */ a, /** @type {number} */ v)=>view.setUint16(at(a), v, true),
        setU32: (/** @type {number} */ a, /** @type {number} */ v)=>
            view.setUint32(at(a), v >>> 0, true),
        setF32: (/** @type {number} */ a, /** @type {number} */ v)=>view.setFloat32(at(a), v, true),
        setF64: (/** @type {number} */ a, /** @type {number} */ v)=>view.setFloat64(at(a), v, true),
        controlWord: ()=>word,
        setControlWord: (/** @type {number} */ v)=>{
            word = v;
        },
        pointerBytes: slotBytes,
        host: ()=>{
            handed = true;
            return 0;
        },
        wasHanded: ()=>handed,
        word: ()=>word,
    };
}

/** The host's side over a case's memory, as msvcrt's table has it. @param {Uint8Array} bytes @param {number} slotBytes */
function hostOf(bytes, slotBytes){
    // The handlers' view of the case's memory, at the slots' width. A store
    // through a null place, or one a place over the list made of a later
    // slot, is the host's alone, and lands nowhere here.
    const host = { guest: guestThrough(
        (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address - DATA, address - DATA + length),
        (/** @type {number} */ address, /** @type {Uint8Array} */ written)=>{
            if (address >= DATA && address + written.length <= DATA + SIZE)
            {
                bytes.set(written, address - DATA);
            }
        }, /** @type {4 | 8} */ (slotBytes)) };
    return { sscanf: createScanFunctions(host).sscanf.handler, listed: listScanHandler(host) };
}

/**
 * The places sscanf's own handler is given: the list's slots, each whole as a
 * 64-bit caller's slot holds it - a slot whose high half is set names a place
 * past 4 GiB, which the list's handler stores through too, not 4 GiB lower.
 */
const placesOf = (/** @type {Uint8Array} */ bytes, /** @type {number} */ slotBytes)=>{
    const view = new DataView(bytes.buffer);
    return Array.from({ length: 32 }, (_, i)=>view.getUint32(LIST - DATA + slotBytes * i, true)
        + (slotBytes === 8 ? view.getUint32(LIST - DATA + slotBytes * i + 4, true) * 2 ** 32 : 0));
};

test('sscanf in the guest answers and stores what the host\'s scanner does, or hands the call'
    + ' over with nothing written, on slots of four bytes and of eight', ()=>{
    for (const slotBytes of [4, 8])
    {
        const next = random(71 + slotBytes);
        let taken = 0;
        /** @type {Record<string, number>} */
        const stored = {};
        for (let round = 0; round < 20000; round++)
        {
            const { format, input } = caseOf(next);
            const before = memoryOf(format, input, next, slotBytes);
            const guestMemory = before.slice();
            const hostMemory = before.slice();
            const label = `${slotBytes}-byte slots, round ${round}: ${JSON.stringify(input)} by `
                + JSON.stringify(format);
            const helpers = helpersOf(guestMemory, slotBytes);
            const answer = sources.scanList(/** @type {any} */ (helpers), INPUT, FORMAT, LIST);
            const host = hostOf(hostMemory, slotBytes);
            const expected = host.sscanf([INPUT, FORMAT, ...placesOf(before, slotBytes)]);
            assert.equal(helpers.word(), 0x27f, `${label}: the control word put back`);
            if (helpers.wasHanded())
            {
                assert.deepEqual(guestMemory, before, `${label}: handed over, nothing written`);
                // What the code hands over reaches the list's handler, which
                // is sscanf's own over the same places - where no store lands
                // on the list: sscanf's own has read every slot by then, the
                // list's reads each as its conversion comes, as the runtime does.
                if (placesOf(before, slotBytes).some(place=>place === LIST + 2))
                {
                    continue;
                }
                const listed = hostOf(guestMemory, slotBytes).listed([INPUT, FORMAT, LIST]);
                assert.equal(listed, expected, `${label}: the list's handler, the answer`);
                assert.deepEqual(guestMemory, hostMemory, `${label}: the list's handler, memory`);
                continue;
            }
            taken++;
            assert.equal(answer, expected, `${label}: the answer`);
            const differs = guestMemory.findIndex((byte, i)=>byte !== hostMemory[i]);
            assert.equal(differs, -1, `${label}: memory differs at 0x${(DATA + differs)
                .toString(16)}`);
            for (const conversion of format.match(/[a-zA-Z](?=[^a-zA-Z]|$)/g) ?? [])
            {
                stored[conversion] = (stored[conversion] ?? 0) + (answer > 0 ? 1 : 0);
            }
        }
        assert.ok(taken > 8000, `${slotBytes}: ${taken} calls answered in the guest`);
        // Every conversion the code takes was among the calls that assigned something.
        for (const conversion of 'diuxXofgeEGscpPaA')
        {
            assert.ok((stored[conversion] ?? 0) > 20,
                `${slotBytes}: %${conversion} assigned in ${stored[conversion] ?? 0} calls`);
        }
    }
});

test('what a program asks of sscanf, in the guest: every case answered there', ()=>{
    /** @type {[string, string][]} */
    const cases = [['42', '%d'], ['1.5 2.25 -3', '%f %f %f'], ['640,480', '%d,%d'],
        ['name 7', '%s %d'], ['ff00ff', '%x'], ['0.5,0.25,1,1', '%f,%f,%f,%f'], ['-12', '%i'],
        ['12345', '%2d%3d'], ['a b', '%c %c'], ['3.0', '%lf'], ['65535', '%hu'],
        ['123456789012', '%I64d'], ['x=5', 'x=%d'], ['  17', '%u'], ['1e3', '%g'], ['', '%d'],
        ['abc', '%d'], ['7 skipped 9', '%d %*s %d']];
    for (const slotBytes of [4, 8])
    {
        for (const [input, format] of cases)
        {
            const before = memoryOf(format, input, ()=>5, slotBytes);
            const guestMemory = before.slice();
            const hostMemory = before.slice();
            const helpers = helpersOf(guestMemory, slotBytes);
            const answer = sources.scanList(/** @type {any} */ (helpers), INPUT, FORMAT, LIST);
            assert.equal(helpers.wasHanded(), false, `${input} by ${format}: in the guest`);
            assert.equal(answer, hostOf(hostMemory, slotBytes).sscanf([INPUT, FORMAT,
                ...placesOf(before, slotBytes)]), `${input} by ${format}: the answer`);
            assert.deepEqual(guestMemory, hostMemory, `${input} by ${format}: memory`);
        }
    }
});

test('a percent sign matched and a conversion suppressed take no slot: a place just past the '
    + 'slots a format stores through is no part of the list', ()=>{
    /** @type {[string, string, number][]} input, format, the slots it stores through */
    const cases = [['50% 7 9', '50%% %*d %d', 1], ['a 1 2', '%*c %d %d', 2],
        ['100%100%5', '%d%%%*d%%%d', 2], [`${'%'.repeat(40)}3`, `${'%%'.repeat(40)}%d`, 1]];
    for (const slotBytes of [4, 8])
    {
        for (const [input, format, slots] of cases)
        {
            const before = memoryOf(format, input, ()=>5, slotBytes);
            // The last place stored through is the first bytes past the slots.
            const view = new DataView(before.buffer);
            view.setUint32(LIST - DATA + slotBytes * (slots - 1), LIST + slotBytes * slots, true);
            const guestMemory = before.slice();
            const hostMemory = before.slice();
            const helpers = helpersOf(guestMemory, slotBytes);
            const answer = sources.scanList(/** @type {any} */ (helpers), INPUT, FORMAT, LIST);
            assert.equal(helpers.wasHanded(), false, `${input} by ${format}: in the guest`);
            assert.equal(answer, slots, `${input} by ${format}: every conversion assigned`);
            assert.equal(answer, hostOf(hostMemory, slotBytes).sscanf([INPUT, FORMAT,
                ...placesOf(before, slotBytes)]), `${input} by ${format}: the answer`);
            assert.deepEqual(guestMemory, hostMemory, `${input} by ${format}: memory`);
        }
    }
});

test('sscanf\'s x86 and x86-64 answer and store as its JavaScript, under a control word of'
    + ' either precision', ()=>{
    /** The host's scanner, as a stand-in: an answer of its own, nothing written. */
    const handed = { host: ()=>0x7ffffff0 };
    const next = random(73);
    for (let round = 0; round < 1500; round++)
    {
        const { format, input } = caseOf(next);
        const seed = next();
        const control = pick(next, [0x37f, 0x27f, 0x7f, 0xc7f, 0x67f]);
        const memory = /** @type {[number, Uint8Array][]} */ ([[DATA,
            memoryOf(format, input, random(seed), 4)]]);
        same('scanList', { stack: [INPUT, FORMAT, LIST], memory, control }, handed);
        const wide = /** @type {[number, Uint8Array][]} */ ([[DATA,
            memoryOf(format, input, random(seed), 8)]]);
        sameAt64('scanList', { stack: [INPUT, FORMAT, LIST], memory: wide }, handed);
    }
    same('scanList', { stack: [0, FORMAT, LIST] }, handed);
    same('scanList', { stack: [INPUT, 0, LIST] }, handed);
    sameAt64('scanList', { stack: [0, FORMAT, LIST] }, handed);
});
