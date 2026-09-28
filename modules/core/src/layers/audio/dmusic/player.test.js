/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, volumeToGain } from './player.js';

/** A clock the test moves by hand. */
function clock(){ return { at: 0, now(){ return this.at; } }; }
/** A mixer that remembers every track opened and what it was given. */
function mixer(){
    /** @type {any[]} */
    const tracks = [];
    return {
        tracks,
        open(/** @type {any} */ format){
            const track = {
                format, gain: 1, closed: false, bytes: 0,
                /** @param {Uint8Array} data */
                write(data){ track.bytes += data.length; },
                close(){ track.closed = true; },
            };
            tracks.push(track);
            return track;
        },
    };
}

/** @param {number} lengthMs @param {number} timeMs */
const item = (lengthMs, timeMs)=>({
    timeMs,
    samples: new Uint8Array(lengthMs * 2),
    sampleRate: 1000,
    channels: 1,
    gain: 1,
});

test('a wave opens when its moment arrives and not before', ()=>{
    const time = clock();
    const out = mixer();
    const player = createPlayer({ now: ()=>time.now(), output: ()=>out });
    const program = { items: [item(100, 0), item(100, 300)], lengthMs: 1000 };
    player.start(program, { plays: 1 });
    assert.equal(out.tracks.length, 1, 'the wave at time zero starts at once');
    time.at = 100;
    player.tick();
    assert.equal(out.tracks.length, 1, 'the wave at 300 ms has not arrived');
    time.at = 300;
    player.tick();
    assert.equal(out.tracks.length, 2);
});

test('one pass ends at the segment length and closes its tracks', ()=>{
    const time = clock();
    const out = mixer();
    const player = createPlayer({ now: ()=>time.now(), output: ()=>out });
    player.start({ items: [item(100, 0)], lengthMs: 1000 }, { plays: 1 });
    time.at = 999;
    player.tick();
    assert.equal(player.voices().length, 1);
    time.at = 1000;
    player.tick();
    assert.equal(player.voices().length, 0);
    assert.equal(out.tracks[0].closed, true);
});

test('a segment that repeats for ever opens a fresh track each pass', ()=>{
    const time = clock();
    const out = mixer();
    const player = createPlayer({ now: ()=>time.now(), output: ()=>out });
    player.start({ items: [item(100, 0)], lengthMs: 1000 }, { plays: Infinity });
    time.at = 1000;
    player.tick();
    assert.equal(out.tracks.length, 2, 'the second pass opened its own wave');
    assert.equal(out.tracks[0].closed, true, 'the first pass released its track');
    time.at = 2500;
    player.tick();
    assert.equal(out.tracks.length, 3);
    assert.equal(player.voices().length, 1);
});

test('stopping a voice closes what it opened', ()=>{
    const out = mixer();
    const player = createPlayer({ now: ()=>0, output: ()=>out });
    player.start({ items: [item(100, 0)], lengthMs: 1000 }, { plays: Infinity });
    player.stopWhere(()=>true);
    assert.equal(out.tracks[0].closed, true);
    assert.equal(player.voices().length, 0);
});

test('with nothing draining the ring the clock still runs and the voices end', ()=>{
    const time = clock();
    const player = createPlayer({ now: ()=>time.now(), output: ()=>null });
    player.start({ items: [item(100, 0)], lengthMs: 1000 }, { plays: 1 });
    time.at = 1000;
    player.tick();
    assert.equal(player.voices().length, 0);
    assert.equal(player.diagnostics().opened, 0);
});

test('volume in hundredths of a decibel becomes a linear gain', ()=>{
    assert.equal(volumeToGain(0), 1);
    assert.ok(volumeToGain(-600) > 0.49 && volumeToGain(-600) < 0.51);
    assert.equal(volumeToGain(-10000), 0);
});
