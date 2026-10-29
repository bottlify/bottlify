/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a child's sound beside its parent: in `compatible` mode the
 * child's tracks mix into its parent's engine mixer (`borrow`), on an
 * isolated page they are slots of the run's shared table read by the
 * worklet's own arithmetic (`resampleInto`). Seeded sequences of tracks
 * opened, written and closed by the parent and the child go down both, and
 * what the speaker is given -- every frame, both sides -- must be the same.
 *
 * The tracks are at the output's own rate, where neither backend resamples:
 * the two sum the same samples in the same order, so they agree to float32
 * rounding (1e-6). A track at another rate is resampled by each backend's own
 * rule and is not compared here (`mix.test.js`, `mixer.test.js`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMixer } from './mixer.js';
import { SLOTS, SLOT_HEADER_INT32, SLOT_BYTES, createSeam, resampleInto, slotHeaderOffset,
    slotPcmOffset } from './mix.js';

const RATE = 48000;
const BLOCK = 64;

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ state >>> 15, 1 | state);
        mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed);
        return ((mixed ^ mixed >>> 14) >>> 0) / 2 ** 32;
    };
}

/** @param {number[]} samples signed 16-bit, interleaved */
const pcm16 = samples=>{
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((value, at)=>view.setInt16(at * 2, value, true));
    return bytes;
};

/**
 * A seeded program of both processes: opens, writes and closes, each close
 * after what its track had was played out.
 *
 * @param {number} seed @param {boolean} child  whether a child plays too
 */
function program(seed, child){
    const next = random(seed);
    /** @type {any[]} */
    const steps = [];
    let made = 0;
    /** @type {{ id: number, owner: string, channels: number }[]} */
    const open = [];
    for (let step = 0; step < 60; step++)
    {
        const owner = child && next() < 0.5 ? 'child' : 'parent';
        const kind = next();
        if (kind < 0.25 || open.length === 0)
        {
            const channels = next() < 0.5 ? 1 : 2;
            open.push({ id: made, owner, channels });
            steps.push({ op: 'open', id: made++, owner, channels });
        }
        else if (kind < 0.85)
        {
            const track = open[Math.floor(next() * open.length)];
            const frames = 1 + Math.floor(next() * 300);
            const samples = Array.from({ length: frames * track.channels },
                ()=>Math.floor(next() * 65536) - 32768);
            steps.push({ op: 'write', id: track.id, bytes: pcm16(samples) });
        }
        else
        {
            const [track] = open.splice(Math.floor(next() * open.length), 1);
            steps.push({ op: 'close', id: track.id });
        }
    }
    return steps;
}

/**
 * Plays a program through two processes' mixers and the reader that drains
 * them, block by block until nothing is left after each step.
 *
 * @param {any[]} steps
 * @param {{ parent: any, child: any, render: (frames: number) => Float32Array }} output
 */
function play(steps, { parent, child, render }){
    /** @type {Map<number, any>} */
    const tracks = new Map();
    /** @type {number[]} */
    const heard = [];
    for (const step of steps)
    {
        if (step.op === 'open')
        {
            const track = (step.owner === 'child' ? child : parent).open(
                { sampleRate: RATE, channels: step.channels, bitsPerSample: 16 });
            track.gain = 1;
            tracks.set(step.id, track);
        }
        else if (step.op === 'write')
        {
            tracks.get(step.id).write(step.bytes);
        }
        else
        {
            tracks.get(step.id).close();
            tracks.delete(step.id);
        }
        for (let guard = 0; guard < 1000; guard++)
        {
            const block = render(BLOCK);
            if (block.length === 0)
            {
                break;
            }
            heard.push(...block);
        }
    }
    return heard;
}

/** The engine backend: the child borrows the parent's mixer, the ring is the speaker. */
function compatible(){
    const parent = createMixer({ sampleRate: RATE });
    const child = parent.borrow({});
    return {
        parent, child,
        /** @param {number} frames */
        render(frames){
            const written = parent.pump(frames);
            const out = new Float32Array(written * 2);
            parent.ring.read(out);
            return out;
        },
    };
}

/** The shared backend: the child's slots on the run's table, read as the worklet reads them. */
function isolated(){
    const parent = createMixer({ shared: true, sampleRate: RATE });
    const child = createMixer({ shared: true, sampleRate: RATE, memory: parent.memory,
        beside: { arena: null } });
    const seams = Array.from({ length: SLOTS }, ()=>createSeam());
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: new Int32Array(parent.table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: new Uint8Array(parent.table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    return {
        parent, child,
        /** @param {number} frames */
        render(frames){
            const block = new Float32Array(frames * 2);
            let most = 0;
            slots.forEach((slot, at)=>{
                most = Math.max(most, resampleInto({ block, blockFrames: frames,
                    header: slot.header, pcm: slot.pcm, outputRate: RATE, seam: seams[at] }));
            });
            return block.subarray(0, most * 2);
        },
    };
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
{
    for (const child of [true, false])
    {
        test(`a child's sound and its parent's reach the speaker alike in either mode (seed ${seed}`
            + `${child ? '' : ', no child'})`, ()=>{
            const steps = program(seed, child);
            const compatibleHeard = play(steps, compatible());
            const isolatedHeard = play(steps, isolated());
            assert.ok(compatibleHeard.length > 0, 'something was played');
            assert.equal(compatibleHeard.length, isolatedHeard.length, 'as many frames');
            const worst = compatibleHeard.reduce((most, value, at)=>
                Math.max(most, Math.abs(value - isolatedHeard[at])), 0);
            assert.ok(worst < 1e-6, `the same samples, worst difference ${worst}`);
        });
    }
}
