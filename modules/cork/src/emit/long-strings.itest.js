/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long mode's `rep movs` and `rep stos` taken a page's run at once
 * (`bulkStringLong`) beside the long-mode interpreter, which runs them an
 * element at a time: seeded programs that set the pointers anywhere in the
 * corpus's two data pages -- at their start, across the boundary between
 * them, at the end, where a run reaches a closed page and faults --, the
 * count, the direction and the value, and run every width. A copy's source
 * and destination lie apart, onto each other and a few bytes ahead of each
 * other either way; a fill's value is one byte repeated (a fill) or not (an
 * element at a time).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare, program } from '../testing/long-machine.js';
import { ifRoom } from '../testing/memory64.js';

/** @param {number} value  as four bytes, low first */
const le = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const DATA = CORPUS.dataAt;
/** Places in the data area: its pages' starts and ends and the boundary between them. */
const PLACES = [0, 1, 7, 0x40, 0x7f9, 0xff0, 0xff8, 0xffc, 0xfff, 0x1000, 0x1001, 0x1008,
    0x1400, 0x1ff0, 0x1ff8, 0x1fff].map(at=>DATA + at);
const POOL = [
    // rep movsb, movsw, movsd, movsq; rep stosb, stosw, stosd, stosq.
    [0xf3, 0xa4], [0xf3, 0x66, 0xa5], [0xf3, 0xa5], [0xf3, 0x48, 0xa5],
    [0xf3, 0xaa], [0xf3, 0x66, 0xab], [0xf3, 0xab], [0xf3, 0x48, 0xab],
    // cld twice as often as std.
    [0xfc], [0xfc], [0xfd],
    // mov ecx, count.
    ...[0, 1, 2, 3, 8, 17, 64, 255, 511, 1000, 4096, 5000].map(count=>[0xb9, ...le(count)]),
    // mov esi, place; mov edi, place.
    ...PLACES.flatMap(at=>[[0xbe, ...le(at)], [0xbf, ...le(at)]]),
    // The destination beside the source: lea rdi, [rsi + d].
    ...[1, 2, 4, 8, 16, -1, -2, -4, -8, -16, 0].map(by=>[0x48, 0x8d, 0x7e, by & 255]),
    // mov eax: one byte repeated, and not.
    ...[0, 0x41414141, 0xffffffff, 0x12345678, 0x00410041, 0x41].map(value=>[0xb8, ...le(value)]),
    // mov rax, 0x4141414141414141 and one whose halves differ.
    [0x48, 0xb8, ...le(0x41414141), ...le(0x41414141)],
    [0x48, 0xb8, ...le(0x41414141), ...le(0x42424242)],
    // A pointer past 4 GiB: bts rdi, 33.
    [0x48, 0x0f, 0xba, 0xef, 33],
].map(bytes=>Buffer.from(bytes));

test('long mode\'s rep movs and rep stos run a page at once as an element at a time: what'
    + ' they leave in memory and the registers, and where they fault', ifRoom(()=>{
    const cases = Array.from({ length: 1500 }, (_, i)=>program(POOL, 0x51a0 + i, 4 + i % 13));
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, { budget });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
}));
