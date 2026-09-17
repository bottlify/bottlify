/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMixer } from './mixer.js';
import { createRing } from './ring.js';
import {
    WRITTEN, DROP_TO, READ, STATE, STATE_FREE, slotHeaderOffset, slotPcmOffset,
    SLOT_HEADER_INT32, SLOT_BYTES, createSeam, resampleInto,
} from './mix.js';

/** Sixteen-bit stereo at the output's own rate: no conversion in the way. */
const DIRECT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

/** @param {number[]} samples signed 16-bit, interleaved */
const pcm16 = samples=>{
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((value, at)=>view.setInt16(at * 2, value, true));
    return bytes;
};

/** @param {any} mixer @param {number} frames */
const drain = (mixer, frames)=>{
    const out = new Float32Array(frames * mixer.channels);
    mixer.ring.read(out);
    return [...out];
};

test('a track carries its samples through to the ring', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    track.write(pcm16([32767, -32768, 16384, -16384]));
    assert.equal(mixer.pump(), 2, 'two stereo frames');

    const heard = drain(mixer, 2);
    assert.ok(Math.abs(heard[0] - 1) < 0.001);
    assert.ok(Math.abs(heard[1] + 1) < 0.001);
    assert.ok(Math.abs(heard[2] - 0.5) < 0.001);
});

test('a mixer over the ring of one it replaced continues the stream', ()=>{
    // A process replacement is not a device replacement. The reader on the
    // other side -- a worklet, a person's sound card -- was handed the ring
    // once and holds it across the change, so the rebuilt machine must mix
    // into that same storage, leaving the reader's place untouched.
    const first = createMixer({ capacityFrames: 32 });
    const music = first.open(DIRECT);
    music.write(pcm16([1000, 1000, 2000, 2000]));
    assert.equal(first.pump(), 2);

    // The reader takes those two frames and keeps its cursor.
    const reader = createRing({ channels: 2, capacityFrames: 32, memory: first.ring.memory });
    assert.equal(reader.read(new Float32Array(4)), 2);

    const second = createMixer({ memory: first.ring.memory });
    assert.equal(second.ring.memory, first.ring.memory, 'the output that already exists');
    assert.equal(second.diagnostics().produced, 2,
        "the frames already in the ring are the device's, not one mixer's");

    const child = second.open(DIRECT);
    child.write(pcm16([3000, 3000, 4000, 4000]));
    assert.equal(second.pump(), 2);

    // The same reader, continuing: the child's frames, in order, where the
    // parent's left off -- no gap and no restart from the beginning.
    const rest = new Float32Array(4);
    assert.equal(reader.read(rest), 2);
    const heard = [...rest];
    assert.ok(Math.abs(heard[0] - 3000 / 32768) < 0.001, 'the first frame after the parent');
    assert.ok(Math.abs(heard[2] - 4000 / 32768) < 0.001, 'and the next, in order');
});

test('two tracks are added together rather than played in turn', ()=>{
    const mixer = createMixer();
    const music = mixer.open(DIRECT);
    const effect = mixer.open(DIRECT);

    music.write(pcm16([8192, 8192]));
    effect.write(pcm16([8192, 8192]));
    assert.equal(mixer.pump(), 1);

    const heard = drain(mixer, 1);
    assert.ok(Math.abs(heard[0] - 0.5) < 0.001, 'a quarter plus a quarter');
});

test('a paused track contributes nothing and keeps what it had', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT);
    track.write(pcm16([16384, 16384]));

    track.paused = true;
    assert.equal(mixer.pump(), 0);

    track.paused = false;
    assert.equal(mixer.pump(), 1, 'the samples were kept, not dropped');
});

test('eight-bit audio is unsigned and silence in it is 128', ()=>{
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 8 });

    track.write(new Uint8Array([128, 255, 0]));
    mixer.pump();

    const heard = drain(mixer, 3);
    // Read as signed this would be a loud constant offset rather than silence.
    assert.equal(heard[0], 0, 'silence');
    assert.ok(heard[2] > 0.9, 'and full scale up');
    assert.ok(heard[4] < -0.9, 'and full scale down');
});

test('a mono source is heard from both sides', ()=>{
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });

    track.write(pcm16([16384]));
    mixer.pump();

    const heard = drain(mixer, 1);
    assert.equal(heard[0], heard[1]);
    assert.ok(heard[0] > 0.49);
});

test('a slower source is resampled to the output rate', ()=>{
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 24000, channels: 2, bitsPerSample: 16 });

    // Half the rate, so about twice as many output frames come out. A single
    // buffer holds its last fractional frame back to join the next one, so a
    // four-frame buffer yields six now rather than the naive eight.
    track.write(pcm16([1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000]));
    assert.equal(mixer.pump(), 6);
});

test('a stream resampled across two buffers has no discontinuity at the seam', ()=>{
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 24000, channels: 2, bitsPerSample: 16 });

    // One continuous ramp of step 1000, delivered as two buffers. At double the
    // rate the output is the same ramp at step 500, and the seam between the
    // buffers must carry that step -- a resampler that restarted each buffer
    // would put a flat or a jump there, which is the click this fixes.
    track.write(pcm16([1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000]));
    track.write(pcm16([5000, 5000, 6000, 6000, 7000, 7000, 8000, 8000]));
    const frames = mixer.pump();
    const out = drain(mixer, frames);

    const scale = 32768;
    // Left channel only; both channels carry the same ramp here.
    const left = out.filter((_, index)=>index % 2 === 0).map(value=>Math.round(value * scale));
    for (let index = 1; index < left.length; index++)
    {
        assert.equal(left[index] - left[index - 1], 500,
            `step ${index} is ${left[index] - left[index - 1]}, not 500 -- a seam discontinuity`);
    }
    assert.equal(left[0], 1000, 'the ramp starts where the stream did');
});

test('the play position is what the device took, not what was written', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    track.write(pcm16(new Array(200).fill(1000)));
    mixer.pump();
    assert.equal(track.played(), 0, 'nothing has been read out of the ring yet');

    drain(mixer, 40);
    assert.equal(track.played(), 40);

    drain(mixer, 60);
    assert.equal(track.played(), 100);
});

test('the position never goes backwards', ()=>{
    // A program reads this as a cursor and would take a decrease for the
    // buffer having wrapped.
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    track.write(pcm16(new Array(100).fill(1000)));
    mixer.pump();
    drain(mixer, 50);
    const reached = track.played();

    track.write(pcm16(new Array(100).fill(1000)));
    mixer.pump();
    assert.ok(track.played() >= reached);
});

test('a closed track stops being mixed', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT);
    track.write(pcm16([16384, 16384]));
    track.close();

    assert.equal(mixer.pump(), 0);
    assert.equal(mixer.diagnostics().tracks, 0);
});

test('a full ring refuses the rest instead of holding a guest thread', ()=>{
    const mixer = createMixer({ capacityFrames: 16 });
    const track = mixer.open(DIRECT);

    track.write(pcm16(new Array(200).fill(1000)));
    assert.equal(mixer.pump(), 16, 'only what fits');
    assert.equal(mixer.pump(), 0, 'and the rest waits rather than blocking');

    drain(mixer, 16);
    assert.equal(mixer.pump(), 16, 'which it then gets');
});

test('a buffer that has been played reports back every byte the guest wrote', ()=>{
    // The figure a waveOut cursor is built on. Converting frames back to bytes
    // by the rate ratio floors, so a buffer played in full reports a fraction
    // short and never retires -- which is how a sound library's one-buffer
    // probe of a device waits for ever.
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    const written = pcm16([1000, -1000, 2000, -2000]);
    track.write(written);
    mixer.pump();
    mixer.ring.read(new Float32Array(2 * mixer.channels));

    assert.equal(track.playedBytes(), written.length);
});

test('the ledger does not grow with everything the program has ever played', ()=>{
    // It is walked from `settle`, which every winmm entry point reaches, so a
    // ledger that only grew made a game that streams sound get steadily slower
    // for as long as it played -- with the cost falling on the guest thread.
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    let expected = 0;
    for (let buffer = 0; buffer < 200; buffer++)
    {
        const written = pcm16([100, -100, 200, -200]);
        track.write(written);
        expected += written.length;
        mixer.pump();
        mixer.ring.read(new Float32Array(2 * mixer.channels));
        assert.equal(track.playedBytes(), expected, `after buffer ${buffer}`);
    }

    assert.ok(track.ledger.length <= 1,
        `nothing behind the cursor is kept, held ${track.ledger.length}`);
});

test('a stopped device starts counting from nothing again', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    track.write(pcm16([500, -500]));
    mixer.pump();
    mixer.ring.read(new Float32Array(mixer.channels));
    assert.ok(track.playedBytes() > 0);

    track.reset();
    assert.equal(track.playedBytes(), 0,
        'what a stopped device played is not owed to the next one');
});

test('a one-frame probe at a resampled rate comes back to the program', ()=>{
    // How a sound library brings a device up: open it, hand it a single frame,
    // and wait for that frame before writing anything else. A frame is one
    // sample per channel, and at a rate the resampler has to convert it emits
    // no output at all -- there is no next input frame to interpolate towards,
    // so it is carried into the seam instead. Crediting the ledger with what
    // came out rather than with what went in left the probe uncredited, the
    // library waiting on it for ever, and the game silent behind that wait.
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 44100, channels: 2, bitsPerSample: 16 });

    const probe = pcm16([1000, -1000]);
    assert.equal(track.write(probe), 0, 'the assumption under this test');
    mixer.pump();

    assert.equal(track.playedBytes(), probe.length,
        'a frame the resampler absorbed is a frame the program is finished with');
});

test('a frame held back for the seam is heard in the buffer after it', ()=>{
    // The frame the probe above was credited for is not thrown away: it lives
    // in the resampler's seam and is the first thing the next buffer emits.
    // Retiring a buffer early would be worth nothing if it cost the sound.
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 24000, channels: 2, bitsPerSample: 16 });

    // Loud on its own, against a silent buffer after it: if the carried frame
    // were dropped the stream would open at silence instead.
    track.write(pcm16([32767, 32767]));
    track.write(pcm16([0, 0, 0, 0]));
    mixer.pump();

    const heard = drain(mixer, 2);
    assert.ok(heard[0] > 0.9,
        `the carried frame opens the next buffer, heard ${heard[0]}`);
});

test('silence written for an idle track is counted against that track', ()=>{
    // A block is as long as the longest track has to give, so every other track
    // has silence written into its own stream for the rest of it. Whether that
    // matters depends entirely on which track it fell on -- a stream somebody
    // is listening to, or one that had stopped -- and a single total cannot
    // tell those apart. It is attributed here so a measurement can.
    const mixer = createMixer();
    const playing = mixer.open(DIRECT);
    const idle = mixer.open(DIRECT);

    playing.write(pcm16([1000, -1000, 2000, -2000, 3000, -3000]));
    mixer.pump();

    assert.equal(playing.short, 0, 'the track carrying the block is never short');
    assert.equal(idle.short, 3, 'the idle track was short the whole block');
});

// The shared-table backend below. `createMixer()` with no options is every
// test above, unchanged -- `shared: true` is what reaches this backend at
// all.

/** @param {any} mixer @param {number} slot */
const slotView = (mixer, slot)=>({
    header: new Int32Array(mixer.table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
    pcm: new Uint8Array(mixer.table, slotPcmOffset(slot), SLOT_BYTES),
});

test('with a shared table, write puts the guest\'s own bytes into the slot', ()=>{
    // There is no `convert` in this backend's own module for a spy to catch --
    // its absence is the point -- so the assertion is on the observable
    // instead: the bytes that land in the slot are the bytes that went in,
    // unrounded, and `WRITTEN` moved by exactly that many.
    const mixer = createMixer({ shared: true });
    const track = mixer.open(DIRECT);
    const written = pcm16([1234, -1234, 5678, -5678]);

    const taken = track.write(written);
    assert.equal(taken, written.length, 'the whole buffer fit');

    const { header, pcm } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, WRITTEN), written.length);
    assert.deepEqual([...pcm.subarray(0, written.length)], [...written],
        'byte-equal: nothing converted it');
});

test('with a shared table, pump() allocates no Float32Array', ()=>{
    const seen = { count: 0 };
    class CountingFloat32Array extends Float32Array {
        /** @param {ConstructorParameters<typeof Float32Array>} args */
        constructor(...args){
            super(...args);
            seen.count++;
        }
    }
    const realFloat32Array = globalThis.Float32Array;
    globalThis.Float32Array = /** @type {any} */ (CountingFloat32Array);
    try
    {
        const mixer = createMixer({ shared: true });
        const track = mixer.open(DIRECT);
        track.write(pcm16([1000, 1000]));
        seen.count = 0;
        mixer.pump();
        assert.equal(seen.count, 0, 'no Float32Array was allocated by pump()');
    }
    finally
    {
        globalThis.Float32Array = realFloat32Array;
    }
});

test('with a shared table, playedBytes() credits a one-frame probe whole '
    + 'once the reader\'s READ passes it', ()=>{
    const mixer = createMixer({ shared: true });
    const track = mixer.open(DIRECT); // the output's own rate: no resampling in the way
    const probe = pcm16([1000, -1000]);
    track.write(probe);
    assert.equal(track.playedBytes(), 0, 'not played until the reader has looked at it');

    // Stand in for the audio thread: advance READ the way resampleInto does.
    const { header } = slotView(mixer, track.slot);
    Atomics.store(header, READ, probe.length);

    assert.equal(track.playedBytes(), probe.length, 'credited whole once READ passed it');
});

test('with a shared table, a backlog past the depth sets DROP_TO', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    const track = mixer.open(DIRECT);
    // 12,000 frames (48,000 samples, stereo) -- past capacityFrames (9,600, 200
    // ms at 48 kHz) and still under one slot's 65,536-byte ring.
    track.write(pcm16(new Array(24000).fill(1000)));

    assert.ok(track.pending() > track.capacityFrames, 'the assumption under this test');
    track.reset();

    const { header } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, DROP_TO), Atomics.load(header, WRITTEN),
        'DROP_TO caught up to WRITTEN');
    assert.equal(track.pending(), 0, 'and the track\'s own view agrees');
});

test('with a shared table, a closed slot is freed by the reader and reused', ()=>{
    // 32 slots (SLOTS in mix.js): fill them all, close one, and the next
    // open() must reuse it -- otherwise a game that opens and closes many
    // short-lived buffers over a session exhausts every slot and falls back
    // permanently.
    const mixer = createMixer({ shared: true });
    const tracks = [];
    for (let i = 0; i < 32; i++)
    {
        tracks.push(mixer.open(DIRECT));
    }
    assert.equal(mixer.open(DIRECT).slot, -1, 'the 33rd track falls back: no free slot');

    const closing = tracks[5];
    const closedSlot = closing.slot;
    closing.close();

    // Only the reader (resampleInto, here standing in for the worklet) may
    // free the slot -- closing it alone must not make it reusable yet.
    assert.equal(mixer.open(DIRECT).slot, -1, 'still no free slot before the reader has run');

    const { header, pcm } = slotView(mixer, closedSlot);
    const block = new Float32Array(2);
    resampleInto({
        block, blockFrames: 1, header, pcm, outputRate: mixer.sampleRate, seam: createSeam(),
    });
    assert.equal(Atomics.load(header, STATE), STATE_FREE, 'the reader freed it');

    const reused = mixer.open(DIRECT);
    assert.equal(reused.slot, closedSlot, 'the next open() reuses the freed slot');
});
