/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMixer } from './mixer.js';
import { GLOBAL_HEADER_INT32, BLOCKS, STARVED_BLOCKS, STARVED_FRAMES } from './mix.js';

const MIX_PATH = fileURLToPath(new URL('./mix.js', import.meta.url));
const WORKLET_PATH = fileURLToPath(new URL('./worklet.js', import.meta.url));

/** @param {string} text @returns {string} the text between the markers, trimmed of the marker lines */
function sharedRegion(text){
    const begin = text.indexOf('WORKLET-SHARED:BEGIN');
    const end = text.indexOf('WORKLET-SHARED:END');
    assert.ok(begin >= 0 && end > begin,
        `markers present in the text (begin=${begin}, end=${end})`);
    return text.slice(text.indexOf('\n', begin) + 1, text.lastIndexOf('\n', end));
}

test('worklet.js duplicates mix.js\'s arithmetic verbatim, not by hand', ()=>{
    const mixText = readFileSync(MIX_PATH, 'utf8');
    const workletText = readFileSync(WORKLET_PATH, 'utf8');
    const fromMix = sharedRegion(mixText).replace(/^export /gm, '');
    const fromWorklet = sharedRegion(workletText);
    assert.equal(fromWorklet, fromMix,
        'worklet.js\'s WORKLET-SHARED region must read exactly like mix.js\'s, export stripped');
});

/**
 * Loads worklet.js's actual source into a sandbox with a stand-in
 * `AudioWorkletProcessor`/`registerProcessor`/`sampleRate`, the way a real
 * audio worklet global scope offers them, and returns the class it registers.
 */
function loadWorkletClass(){
    const source = readFileSync(WORKLET_PATH, 'utf8');
    /** @type {{ name: string, cls: any } | null} */
    let registered = null;
    class FakeAudioWorkletProcessor {
        constructor(){
            this.port = { onmessage: null, postMessage(){} };
        }
    }
    const context = vm.createContext({
        AudioWorkletProcessor: FakeAudioWorkletProcessor,
        registerProcessor: (/** @type {string} */ name, /** @type {any} */ cls)=>{
            registered = { name, cls };
        },
        Atomics, Math,
        Float32Array, Int32Array, Uint8Array, ArrayBuffer, SharedArrayBuffer,
        sampleRate: 48000,
    });
    vm.runInContext(source, context, { filename: WORKLET_PATH });
    assert.ok(registered, 'registerProcessor was called');
    assert.equal(/** @type {any} */ (registered).name, 'bottlify-output');
    return /** @type {any} */ (registered).cls;
}

/** @param {number[]} samples signed 16-bit, interleaved */
const pcm16 = samples=>{
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((value, at)=>view.setInt16(at * 2, value, true));
    return bytes;
};

/** @param {number} frames */
const outputBlock = frames=>[new Float32Array(frames), new Float32Array(frames)];

test('two tracks at different rates and gains come out summed', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    const music = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
    const effect = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
    music.gain = 1;
    effect.gain = 0.5;
    music.write(pcm16([16384, 16384]));
    effect.write(pcm16([16384, 16384]));

    const Processor = loadWorkletClass();
    const processor = new Processor({ processorOptions: { table: mixer.table, channels: 2 } });
    const outputs = [outputBlock(2)];
    processor.process([], outputs);

    // 0.5 (music, full gain) + 0.25 (effect, half gain) on both channels.
    assert.ok(Math.abs(outputs[0][0][0] - 0.75) < 1e-6, `left[0] = ${outputs[0][0][0]}`);
    assert.ok(Math.abs(outputs[0][1][0] - 0.75) < 1e-6, `right[0] = ${outputs[0][1][0]}`);
    assert.equal(music.played(), 2);
    assert.equal(effect.played(), 2);
    assert.equal(music.playedBytes(), 4);
});

test('a track\'s balance reaches the audio thread, one side at a time', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    const left = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
    const right = mixer.open({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
    left.balance = [1, 0];
    right.gain = 0.5;
    right.balance = [0.5, 1];
    assert.deepEqual(left.balance, [1, 0]);
    left.write(pcm16([16384]));
    right.write(pcm16([16384, 16384]));

    const Processor = loadWorkletClass();
    const processor = new Processor({ processorOptions: { table: mixer.table, channels: 2 } });
    const outputs = [outputBlock(1)];
    processor.process([], outputs);

    // Left: 0.5 from the first track, 0.125 from the second; right: the
    // second track's alone, at its gain.
    assert.ok(Math.abs(outputs[0][0][0] - 0.625) < 1e-6, `left[0] = ${outputs[0][0][0]}`);
    assert.ok(Math.abs(outputs[0][1][0] - 0.25) < 1e-6, `right[0] = ${outputs[0][1][0]}`);
});

test('a silent block counts STARVED_BLOCKS and STARVED_FRAMES', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 }); // nothing written

    const Processor = loadWorkletClass();
    const processor = new Processor({ processorOptions: { table: mixer.table, channels: 2 } });
    processor.process([], [outputBlock(16)]);

    const global = new Int32Array(mixer.table, 0, GLOBAL_HEADER_INT32);
    assert.equal(Atomics.load(global, BLOCKS), 1);
    assert.equal(Atomics.load(global, STARVED_BLOCKS), 1);
    assert.equal(Atomics.load(global, STARVED_FRAMES), 16);
});

test('MIXED_FRAMES and READ advance by exactly what was mixed', ()=>{
    const mixer = createMixer({ shared: true, sampleRate: 48000 });
    const track = mixer.open({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
    // More than one block's worth, at the direct rate: one frame in, one out.
    track.write(pcm16(new Array(40).fill(1000)));

    const Processor = loadWorkletClass();
    const processor = new Processor({ processorOptions: { table: mixer.table, channels: 2 } });
    processor.process([], [outputBlock(16)]);
    assert.equal(track.played(), 16);
    assert.equal(track.playedBytes(), 32);

    processor.process([], [outputBlock(16)]);
    assert.equal(track.played(), 32);
    assert.equal(track.playedBytes(), 64);

    // The last 8 frames: a short block, the rest of the output left silent.
    const outputs = [outputBlock(16)];
    processor.process([], outputs);
    assert.equal(track.played(), 40);
    assert.equal(outputs[0][0][7], 1000 / 32768);
    assert.equal(outputs[0][0][8], 0, 'nothing left to mix, so silence rather than a stale value');
});

test('without a table, the processor plays what is posted to the port it is handed', ()=>{
    const BottlifyOutput = loadWorkletClass();
    const processor = new BottlifyOutput({ processorOptions: { channels: 2 } });
    /** @type {any[]} */
    const said = [];
    const feed = { onmessage: /** @type {any} */ (null), postMessage: (/** @type {any} */ m)=>said.push(m) };
    processor.port.onmessage({ data: { type: 'feed', port: feed } });
    feed.onmessage({ data: { at: 10, frames: Float32Array.from([1, -1, 2, -2, 3, -3]) } });

    const outputs = [outputBlock(4)];
    assert.equal(processor.process([], outputs), true);
    assert.deepEqual([...outputs[0][0]], [1, 2, 3, 0]);
    assert.deepEqual([...outputs[0][1]], [-1, -2, -3, 0]);
    for (let block = 1; block < 4; block++)
    {
        processor.process([], [outputBlock(4)]);
    }
    assert.deepEqual({ ...said.at(-1) },
        { played: 13, blocks: 4, starvedBlocks: 4, starvedFrames: 13 },
        'what it played, as a place in the engine\'s ring, and what it found missing');
});
