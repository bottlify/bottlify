/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMixer } from './mixer.js';

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
