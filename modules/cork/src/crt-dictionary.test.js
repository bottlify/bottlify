/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRT_DICTIONARY } from './crt-dictionary.js';
import { CRT_EFFECTS, RUNTIME_HELPERS, helperExtent, helperInstructions } from './helpers.js';
import { decode } from './decode/decoder.js';

/**
 * The fewest bytes a signature leaves unmasked, and the most of it masked: a
 * short stub whose meaning is the address it jumps to -- the address masked --
 * is every other such stub (MSVC's `_CIsqrt`, 8 of its 20 bytes masked,
 * matched eight of them in one image), where a helper of 31 bytes none of
 * them masked is itself.
 */
const SIGNIFICANT_BYTES = 24;
const MASKED_SHARE = 1 / 3;

test('every entry of the dictionary is a signature that tells its function apart', ()=>{
    const hashes = new Set();
    for (const entry of CRT_DICTIONARY)
    {
        const { name, spans = [], masks = [], via } = entry;
        // Stubs alike to the byte are told apart by where they jump (`via`).
        const hash = `${entry.hash}${via === undefined ? '' : ` ${via.at} ${via.hash}`}`;
        assert.ok(!hashes.has(hash), `${name}: one entry for each signature`);
        hashes.add(hash);
        assert.ok(spans.length > 0 && spans[0][0] === 0, `${name}: its first span is its entry's`);
        for (let i = 1; i < spans.length; i++)
        {
            assert.ok(spans[i][0] >= spans[i - 1][0] + spans[i - 1][1], `${name}: spans in order`);
        }
        const inSpans = (/** @type {number} */ at)=>spans.some(([o, n])=>at >= o && at < o + n);
        assert.ok(masks.every((at, i)=>inSpans(at) && (i === 0 || at > masks[i - 1])),
            `${name}: masks in order, each in a span`);
        const code = spans.reduce((sum, [, n])=>sum + n, 0);
        // A stub whose shape is its operation (`shape`) is told by its every unmasked byte:
        // masked, only addresses its operation reads or makes the call to.
        const significant = code - masks.length >= SIGNIFICANT_BYTES
            && masks.length <= code * MASKED_SHARE;
        assert.ok(entry.shape === true || significant,
            `${name}: ${code - masks.length} bytes unmasked of ${code}`);
        assert.ok(entry.shape !== true || entry.word !== undefined,
            `${name}: a shape is a test of a global`);
        const [first, end] = helperExtent(entry);
        assert.equal(entry.length, end - first);
        assert.ok(entry.does !== undefined && entry.does in CRT_EFFECTS, `${name}: does what`);
        assert.ok(RUNTIME_HELPERS.includes(entry), `${name}: looked up by forming`);
    }
});

test('every body of the dictionary is bytes that decode whole, ending where the call does', ()=>{
    const call = decode(at=>[0xe8, 0, 0, 0, 0][at - 0x401000] ?? 0, 0x401000);
    assert.ok(!('refused' in call));
    for (const entry of CRT_DICTIONARY)
    {
        const body = entry.body ?? [];
        assert.ok(body.every(byte=>Number.isInteger(byte) && byte >= 0 && byte < 256),
            `${entry.name}: its body is bytes`);
        const formed = helperInstructions(entry, call, 0x500000);
        assert.equal(formed.reduce((sum, one)=>sum + one.length, 0), 5,
            `${entry.name}: what it is formed as goes on after the call`);
        // The `lead`'s instructions first, where there is one, then the operation's.
        const operation = formed.findIndex(one=>one.op === 'crt');
        assert.ok(entry.lead === undefined ? operation === 0 : operation > 0, entry.name);
    }
});
