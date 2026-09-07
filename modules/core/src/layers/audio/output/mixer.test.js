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

    // Half the rate, so twice as many output frames come out of it.
    track.write(pcm16([1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000]));
    assert.equal(mixer.pump(), 8);
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
