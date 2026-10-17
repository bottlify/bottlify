/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resampleInto, createSeam, slotHeaderOffset, slotPcmOffset, createFeed, playFeed,
    SLOT_HEADER_INT32, SLOT_BYTES, GLOBAL_HEADER_INT32,
    STATE, GENERATION, RATE, CHANNELS, BITS, GAIN, PAUSED, WRITTEN, READ, DROP_TO,
    STATE_OPEN, GAIN_SCALE, TABLE_BYTES, KIND, KIND_DMA, BASE, LENGTH, POSITION, LOOPING, PLAYING,
    LAPS, ENDS, FRESH, STREAMING, HELD, ARENA_OFFSET, ARENA_BYTES,
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

/**
 * A DMA voice over a whole table: slot 0's header, and \`samples\` (signed
 * 16-bit mono) as its mirror at the start of the arena.
 *
 * @param {number[]} samples
 * @param {{ looping?: boolean, rate?: number, channels?: number }} [options]
 */
function voice(samples, { looping = true, rate = 48000, channels = 1 } = {}){
    const table = new ArrayBuffer(TABLE_BYTES);
    const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    arena.set(pcm16(samples), 0);
    for (const [field, value] of /** @type {[number, number][]} */ ([
        [KIND, KIND_DMA], [BASE, 0], [LENGTH, samples.length * 2], [RATE, rate],
        [CHANNELS, channels], [BITS, 16], [GAIN, GAIN_SCALE], [LOOPING, looping ? 1 : 0],
        [PLAYING, 1], [STATE, STATE_OPEN],
    ]))
    {
        Atomics.store(header, field, value);
    }
    const seam = createSeam();
    /** @param {number} frames */
    const mix = frames=>{
        const block = new Float32Array(frames * 2);
        const produced = resampleInto({ block, blockFrames: frames, header, pcm: new Uint8Array(0),
            arena, outputRate: 48000, seam });
        const left = [...block].filter((_, at)=>at % 2 === 0).map(v=>Math.round(v * 32768));
        const right = [...block].filter((_, at)=>at % 2 === 1).map(v=>Math.round(v * 32768));
        return { produced, left, right };
    };
    return { header, mix };
}

test('a DMA voice reads its mirror on the device\'s own clock, round and round', ()=>{
    // A sound card plays the buffer whatever the program is doing: nothing
    // here is written by the engine while the device reads.
    const samples = [100, 200, 300, 400, 500];
    const { header, mix } = voice(samples);
    const first = mix(3);
    assert.deepEqual(first.left, [100, 200, 300]);
    assert.equal(Atomics.load(header, POSITION), 3 * 2, 'the play cursor, in bytes');
    const second = mix(4);
    assert.deepEqual(second.left, [400, 500, 100, 200], 'on round the end to the start');
    assert.equal(Atomics.load(header, LAPS), 1);
    assert.equal(Atomics.load(header, POSITION), 2 * 2);
    assert.equal(Atomics.load(header, PLAYING), 1, 'a loop keeps playing');
});

test('a 5.1 voice is folded into stereo: its centre and surrounds are heard, its LFE is not', ()=>{
    // A film mixed into 5.1 keeps its voice in the centre; heard through the
    // first two channels only, it was silence.
    const frames = [
        [0, 0, 10000, 0, 0, 0],
        [1000, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 2000, 0],
        [0, 0, 0, 0, 0, 2000],
        [0, 0, 0, 30000, 0, 0],
    ];
    const { mix } = voice(frames.flat(), { channels: 6, looping: false });
    const out = mix(5);
    assert.deepEqual(out.left, [7071, 1000, 1414, 0, 0]);
    assert.deepEqual(out.right, [7071, 0, 0, 1414, 0]);
    const stereo = voice([300, -300, 500, -500], { channels: 2, looping: false }).mix(2);
    assert.deepEqual([stereo.left, stereo.right], [[300, 500], [-300, -500]], 'stereo as it is');
});

test('a DMA voice that does not loop stops itself at the end, as a sound card does', ()=>{
    const { header, mix } = voice([100, 200, 300], { looping: false });
    const out = mix(8);
    assert.equal(out.produced, 3, 'the three frames it has, then silence');
    assert.deepEqual(out.left.slice(0, 3), [100, 200, 300]);
    assert.equal(Atomics.load(header, PLAYING), 0);
    assert.equal(Atomics.load(header, POSITION), 0, 'its cursor reads the start again');
    assert.equal(Atomics.load(header, ENDS), 1);
    assert.equal(mix(4).produced, 0, 'and it is quiet until played again');
});

test('a DMA voice at half the output rate moves half a frame an output frame', ()=>{
    const { header, mix } = voice([0, 1000, 2000, 3000], { rate: 24000 });
    const out = mix(4);
    assert.deepEqual(out.left, [0, 500, 1000, 1500], 'interpolated between its frames');
    assert.equal(Atomics.load(header, POSITION), 2 * 2);
});

test('a stream is played up to what was written of it and waits there, silent', ()=>{
    // Round the circle past that, the device would replay the lap before.
    const { header, mix } = voice([100, 200, 300, 400, 500]);
    Atomics.store(header, STREAMING, 1);
    Atomics.store(header, FRESH, 3 * 2);
    assert.deepEqual(mix(5).left, [100, 200, 300, 0, 0]);
    assert.equal(Atomics.load(header, POSITION), 3 * 2, 'held where the writing ends');
    assert.equal(Atomics.load(header, HELD), 2);
    Atomics.store(header, FRESH, (5 + 2) * 2);
    assert.deepEqual(mix(4).left, [400, 500, 100, 200], 'and on once it is written, round the end');
    assert.equal(Atomics.load(header, LAPS), 1);
});

test('a stream nobody writes for a quarter of a second is played on round the circle', ()=>{
    // Its writer has stopped, not fallen behind: the hardware loops the buffer.
    const { header, mix } = voice([100, 200, 300, 400, 500]);
    Atomics.store(header, STREAMING, 1);
    Atomics.store(header, FRESH, 0);
    assert.equal(mix(12001).produced, 0);
    assert.equal(Atomics.load(header, STREAMING), 0);
    assert.deepEqual(mix(2).left, [100, 200]);
});

/** @param {number} at @param {number[]} values */
const chunk = (at, values)=>({ at, frames: Float32Array.from(values) });

test('a feed plays the chunks posted to it in order, across their edges', ()=>{
    const queue = createFeed();
    queue.chunks.push(chunk(0, [1, -1, 2, -2, 3, -3]), chunk(3, [4, -4, 5, -5]));
    const block = new Float32Array(8);
    assert.equal(playFeed(queue, block, 4), 4);
    assert.deepEqual([...block], [1, -1, 2, -2, 3, -3, 4, -4]);
    assert.equal(queue.position, 4, 'where in the ring it has played to');
    assert.equal(playFeed(queue, block, 4), 1);
    assert.deepEqual([...block], [5, -5, 0, 0, 0, 0, 0, 0], 'silence where nothing came');
    assert.equal(queue.position, 5);
    assert.deepEqual({ blocks: queue.blocks, starvedBlocks: queue.starvedBlocks,
        starvedFrames: queue.starvedFrames }, { blocks: 2, starvedBlocks: 1, starvedFrames: 3 });
    assert.equal(queue.chunks.length, 0);
});

test('a feed skips to where a chunk says it starts, as after the ring was cleared', ()=>{
    const queue = createFeed();
    queue.chunks.push(chunk(100, [7, -7]));
    const block = new Float32Array(2);
    assert.equal(playFeed(queue, block, 1), 1);
    assert.equal(queue.position, 101, 'counted from the ring, not from zero');
    queue.chunks.push(chunk(150, [8, -8]));
    playFeed(queue, block, 1);
    assert.deepEqual([...block], [8, -8]);
    assert.equal(queue.position, 151);
});
