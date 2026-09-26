/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resampleInto, createSeam, slotHeaderOffset, slotPcmOffset,
    SLOT_HEADER_INT32, SLOT_BYTES, GLOBAL_HEADER_INT32,
    STATE, GENERATION, RATE, CHANNELS, BITS, GAIN, PAUSED, WRITTEN, READ, DROP_TO,
    STATE_OPEN, GAIN_SCALE, TABLE_BYTES,
} from './mix.js';
import { convert, createMixer } from './mixer.js';

/** @param {number[]} samples signed 16-bit, interleaved */
const pcm16 = samples=>{
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((value, at)=>view.setInt16(at * 2, value, true));
    return bytes;
};

/** One slot's header and PCM ring, built directly over a scratch buffer. */
function slot(){
    const table = new ArrayBuffer(GLOBAL_HEADER_INT32 * 4 + SLOT_HEADER_INT32 * 4 + SLOT_BYTES);
    const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    const pcm = new Uint8Array(table, slotPcmOffset(0), SLOT_BYTES);
    Atomics.store(header, STATE, STATE_OPEN);
    Atomics.store(header, GAIN, GAIN_SCALE);
    return { header, pcm };
}

/** @param {{ header: Int32Array, pcm: Uint8Array }} s @param {Uint8Array} bytes */
function feed(s, bytes){
    const written = Atomics.load(s.header, WRITTEN);
    for (let i = 0; i < bytes.length; i++)
    {
        s.pcm[(written + i) % SLOT_BYTES] = bytes[i];
    }
    Atomics.store(s.header, WRITTEN, written + bytes.length);
}

test('resampleInto matches convert(), sample for sample, across three buffers', ()=>{
    const format = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };
    const buffers = [
        pcm16([1000, 2000, 3000, 4000, 5000]),
        pcm16([6000, 5000, 4000, 3000, 2000, 1000]),
        pcm16([500, -500, 1000, -1000]),
    ];

    // The reference: today's convert(), one call per buffer, its own state
    // carried across them.
    const referenceState = { pos: 0, tail: null };
    /** @type {number[]} */
    const expected = [];
    for (const buffer of buffers)
    {
        expected.push(...convert(buffer, format, 48000, referenceState));
    }

    // Under test: the same three buffers fed into a slot's byte ring, drained
    // through resampleInto with a block generous enough to take each buffer
    // whole in one call -- the same one-call-per-buffer shape convert() has.
    const s = slot();
    Atomics.store(s.header, RATE, format.sampleRate);
    Atomics.store(s.header, CHANNELS, format.channels);
    Atomics.store(s.header, BITS, format.bitsPerSample);
    const seam = createSeam();
    const block = new Float32Array(64 * 2);
    /** @type {number[]} */
    const actual = [];
    for (const buffer of buffers)
    {
        feed(s, buffer);
        block.fill(0);
        const produced = resampleInto({
            block, blockFrames: 64, header: s.header, pcm: s.pcm, outputRate: 48000, seam,
        });
        actual.push(...block.subarray(0, produced * 2));
    }

    assert.equal(actual.length, expected.length, 'the same number of samples came out');
    for (let i = 0; i < expected.length; i++)
    {
        assert.equal(actual[i], expected[i], `sample ${i}: ${actual[i]} !== ${expected[i]}`);
    }
});

test('a GENERATION change resets the seam', ()=>{
    const s = slot();
    Atomics.store(s.header, RATE, 24000);
    Atomics.store(s.header, CHANNELS, 1);
    Atomics.store(s.header, BITS, 16);
    const seam = createSeam();
    const block = new Float32Array(8 * 2);

    // Leaves a fractional read position carried in the seam.
    feed(s, pcm16([1000, 2000, 3000]));
    resampleInto({ block, blockFrames: 8, header: s.header, pcm: s.pcm, outputRate: 48000, seam });
    assert.notEqual(seam.pos, 0, 'the assumption under this test: a carried fraction');

    // A generation bump with fresh data must not blend the old carry in.
    Atomics.add(s.header, GENERATION, 1);
    feed(s, pcm16([9000, 9000, 9000]));
    block.fill(0);
    resampleInto({ block, blockFrames: 8, header: s.header, pcm: s.pcm, outputRate: 48000, seam });
    assert.equal(seam.generation, Atomics.load(s.header, GENERATION),
        'the seam noticed the new generation');
    assert.equal(block[0], 9000 / 32768, 'the first sample after reset starts flat, not blended');
});

test('a DROP_TO ahead of READ is honoured before reading', ()=>{
    const s = slot();
    Atomics.store(s.header, RATE, 48000); // the direct-copy path, no resampling
    Atomics.store(s.header, CHANNELS, 1);
    Atomics.store(s.header, BITS, 16);

    feed(s, pcm16([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    Atomics.store(s.header, DROP_TO, 10); // skip the first 5 frames (10 bytes)
    Atomics.add(s.header, GENERATION, 1);

    const seam = createSeam();
    const block = new Float32Array(10 * 2);
    const produced = resampleInto({
        block, blockFrames: 10, header: s.header, pcm: s.pcm, outputRate: 48000, seam,
    });

    assert.equal(produced, 5, 'only the frames past DROP_TO');
    assert.equal(block[0], 6 / 32768, 'the first frame read is the one DROP_TO pointed at');
    assert.equal(Atomics.load(s.header, READ), 20, 'READ caught up to WRITTEN');
});

test('gain scales the samples and a paused slot contributes nothing', ()=>{
    const s = slot();
    Atomics.store(s.header, RATE, 48000);
    Atomics.store(s.header, CHANNELS, 1);
    Atomics.store(s.header, BITS, 16);
    Atomics.store(s.header, GAIN, GAIN_SCALE / 2);

    feed(s, pcm16([16384]));
    const seam = createSeam();
    const block = new Float32Array(2);
    let produced = resampleInto({
        block, blockFrames: 1, header: s.header, pcm: s.pcm, outputRate: 48000, seam,
    });
    assert.equal(produced, 1);
    assert.ok(Math.abs(block[0] - 0.25) < 1e-9, `half of half scale, got ${block[0]}`);
    assert.ok(Math.abs(block[1] - 0.25) < 1e-9,
        'a header written without a balance, zeroed, plays both sides');

    Atomics.store(s.header, PAUSED, 1);
    feed(s, pcm16([16384]));
    const before = Atomics.load(s.header, READ);
    block.fill(0);
    produced = resampleInto({
        block, blockFrames: 1, header: s.header, pcm: s.pcm, outputRate: 48000, seam,
    });
    assert.equal(produced, 0, 'a paused slot contributes nothing');
    assert.equal(block[0], 0);
    assert.equal(Atomics.load(s.header, READ), before, 'and keeps what it had');
});

test('a mixer over the table stays within TABLE_BYTES', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    assert.equal(mixer.table.byteLength, TABLE_BYTES);
});

test('WRITTEN/READ crossing 2^31 bytes does not stall the ring', ()=>{
    // At 44.1 kHz stereo 16-bit (176,400 B/s) a slot's byte indices cross
    // 2^31 after about 3.4 hours of continuous play -- a night-long session.
    // Formed as plain doubles, `written - read` after the crossing subtracts
    // a negative Int32 load from a positive one and reads as a span far
    // larger than the ring, so `availableFrames` floors to 0 for ever.
    const s = slot();
    Atomics.store(s.header, RATE, 48000); // the direct-copy path
    Atomics.store(s.header, CHANNELS, 2);
    Atomics.store(s.header, BITS, 16);

    const near = 2147483642; // 2^31 - 6: writing two stereo frames crosses it
    Atomics.store(s.header, WRITTEN, near);
    Atomics.store(s.header, READ, near);
    feed(s, pcm16([1000, -1000, 2000, -2000])); // 8 bytes; WRITTEN wraps negative

    const seam = createSeam();
    const block = new Float32Array(4);
    const produced = resampleInto({
        block, blockFrames: 2, header: s.header, pcm: s.pcm, outputRate: 48000, seam,
    });
    assert.equal(produced, 2,
        'the two frames written across the wrap are read, not lost to a stalled span');
});
