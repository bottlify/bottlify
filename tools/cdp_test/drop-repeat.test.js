/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { freezesOf, repeatingDrops, scenesOf } from './drop-repeat.mjs';

/**
 * A run of frames: `scenes` scenes of `seconds` at 5 ms a frame, a 2 s load
 * between them, and a 40 ms frame at each of `drops` ([scene, second]).
 *
 * @param {number} scenes @param {number} seconds @param {[number, number][]} drops
 */
function run(scenes, seconds, drops){
    const frames = [];
    let at = 0;
    for (let s = 0; s < scenes; s++)
    {
        const start = at;
        while (at - start < seconds * 1000)
        {
            const slow = drops.some(([scene, second])=>scene === s
                && at - start >= second * 1000 && at - start < second * 1000 + 5);
            const ms = slow ? 40 : 5;
            frames.push({ index: frames.length, startedAt: at, ms,
                byKind: { guest: ms - 1, host: 1 }, notes: { instructions: 1000 } });
            at += ms;
        }
        at += 2000;
    }
    return frames;
}

test('a run is cut into scenes at its loads', ()=>{
    const scenes = scenesOf(run(3, 4, []), 1500);
    assert.equal(scenes.length, 3);
    assert.ok(scenes.every(scene=>scene.endMs - scene.startMs >= 4000));
});

test('a drop at one point of every run repeats; a drop that wanders does not', ()=>{
    const runs = [0, 1, 2, 3, 4].map(n=>run(2, 6, [[1, 3], [0, n + 0.5]]));
    const result = repeatingDrops(runs, { bin: 1, share: 0.7, gap: 1500 });
    assert.equal(result.scenes.length, 2);
    assert.deepEqual(result.scenes[0].repeating, [], 'the wandering drop is noise');
    assert.equal(result.scenes[1].repeating.length, 1);
    assert.equal(result.scenes[1].repeating[0].fromS, 3);
    assert.equal(result.scenes[1].repeating[0].runs, 5);
});

test('a freeze is listed in its scene with its idle time by what it waited on', ()=>{
    const frames = run(2, 4, [[1, 2]]);
    const slow = frames.find(frame=>frame.ms === 40);
    if (!slow)
    {
        throw new Error('the run has no slow frame');
    }
    slow.ms = 600;
    Object.assign(slow, { idleMs: 500 });
    slow.notes = { instructions: 1000, 'idle-host-wait Sleep': 100,
        'idle-message-wait others': 400, gfxGpuMs: 450 };
    const freezes = freezesOf(frames, 1500, 500);
    assert.equal(freezes[0].length, 0, 'the first scene has none');
    assert.equal(freezes[1].length, 1);
    assert.equal(freezes[1][0].idle, 500);
    assert.deepEqual(freezes[1][0].idleBy[0], ['idle-message-wait others', 400], 'largest first');
    assert.deepEqual(freezes[1][0].worker, [['gfxGpuMs', 450]], 'and the worker beside it');
});
