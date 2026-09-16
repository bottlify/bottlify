/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * "An instrument registers what it measures": the harness turns the engine's
 * own events into the fields a report carries, and this pins that translation
 * against a fake `app` rather than a real machine -- what a request asks for
 * against what reaches `input.send`, what a presented frame does to the
 * counters, and what an emitted event becomes in the collected report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    listen, scheduleKeyTimes, presentFrame, recordSample, resetSamples, profile, byModule,
} from './harness.js';

/** An `app` that only remembers what was sent and what it was asked to do. */
function fakeApp(){
    /** @type {Map<string, ((payload: any) => void)[]>} */
    const handlers = new Map();
    /** @type {any[]} */
    const sent = [];
    return {
        sent,
        input: { send: (/** @type {any} */ message)=>sent.push(message) },
        /** @param {string} name @param {(payload: any) => void} handler */
        on(name, handler){
            const list = handlers.get(name) ?? [];
            list.push(handler);
            handlers.set(name, list);
        },
        attachLog(){},
        /** @param {string} name @param {any} payload */
        emit(name, payload){
            for (const handler of handlers.get(name) ?? [])
            {
                handler(payload);
            }
        },
    };
}

test('a typed key at a moment lands in input.send', async()=>{
    const app = fakeApp();
    scheduleKeyTimes(app, { keyTimes: [{ code: 'KeyA', atMs: 5, holdMs: 10 }] });

    await new Promise(resolve=>setTimeout(resolve, 40));

    assert.deepEqual(app.sent, [
        { kind: 'key', code: 'KeyA', down: true },
        { kind: 'key', code: 'KeyA', down: false },
    ]);
});

test('a presented frame increments the counter and records the gap', ()=>{
    const app = fakeApp();
    /** @type {import('./harness.js').PresentState} */
    const state = { presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], lastPresent: 0, presents: 0 };
    const first = { frameIndex: 0 };

    presentFrame(app, {}, state, first);
    assert.equal(state.presents, 1);
    assert.equal(state.presented, first, 'the harness keeps the last frame it was handed');
    assert.deepEqual(state.gaps, [], 'nothing to gap against on the first frame');

    const second = { frameIndex: 1 };
    presentFrame(app, {}, state, second);
    assert.equal(state.presents, 2);
    assert.equal(state.gaps.length, 1, 'a gap is recorded from the second frame on');
});

test('a held pointer and a scheduled click and key are forwarded per frame', ()=>{
    const app = fakeApp();
    /** @type {import('./harness.js').PresentState} */
    const state = { presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], lastPresent: 0, presents: 0 };
    const request = {
        pointer: { x: 12, y: 34 },
        clicks: [{ x: 50, y: 60, after: 1 }],
        keys: [{ code: 'Enter', after: 1 }],
    };

    presentFrame(app, request, state, {}); // presents === 1
    assert.deepEqual(app.sent[0], { kind: 'pointerMove', x: 12, y: 34, dx: 0, dy: 0 },
        'the held pointer is placed every frame');

    presentFrame(app, request, state, {}); // presents === 2: click and key press
    assert.ok(app.sent.some(message=>message.kind === 'pointerButton' && message.down === true),
        'the click pressed on the frame it was scheduled for');
    assert.ok(app.sent.some(message=>
        message.kind === 'key' && message.code === 'Enter' && message.down === true),
    'the key pressed on the frame it was scheduled for');

    presentFrame(app, request, state, {}); // presents === 3: both release
    assert.ok(app.sent.some(message=>message.kind === 'pointerButton' && message.down === false),
        'the click released one frame after it pressed');
    assert.ok(app.sent.some(message=>
        message.kind === 'key' && message.code === 'Enter' && message.down === false),
    'the key released one frame after it pressed');
});

test('a process-replace is recorded', ()=>{
    const app = fakeApp();
    /** @type {any} */
    const collected = { failures: [], missing: [], output: [], events: [] };
    listen(app, collected);

    app.emit('process-replace', { image: 'C:\\App\\Child.exe', sequenceBase: 42 });

    assert.ok(collected.events.some(
        (/** @type {string} */ line)=>line.startsWith('[process-replace]')
            && line.includes('Child.exe')),
    `a handover is in the report: ${collected.events.join(' | ')}`);
});

test('the draw-path counters are folded by module', t=>{
    t.after(()=>resetSamples());
    resetSamples();
    const layout = ['Game.dll 4096+4096', 'Other.dll 8192+4096'];

    recordSample(4096 + 10, 5); // Game.dll
    recordSample(4096 + 20, 7); // Game.dll, same module as above
    recordSample(8192 + 5, 3); // Other.dll

    const report = profile(layout);
    assert.ok(report, 'a profile exists once a sample has landed');
    assert.equal(report.retired, 15, 'every retirement is folded into the total');
    const byName = Object.fromEntries(report.modules.map((/** @type {any} */ m)=>[m.at, m.count]));
    assert.deepEqual(byName, { 'Game.dll': 12, 'Other.dll': 3 },
        'two addresses in one module fold into one module-level count');
});

test('byModule folds addresses into shares of the whole', ()=>{
    const layout = ['A.dll 0+16', 'B.dll 16+16'];
    const folded = byModule([
        { address: 4, weight: 3 },
        { address: 8, weight: 5 },
        { address: 20, weight: 2 },
    ], layout);

    assert.deepEqual(folded.map((/** @type {any} */ m)=>[m.at, m.count]),
        [['A.dll', 8], ['B.dll', 2]], 'heaviest module first');
    for (const entry of folded)
    {
        assert.equal(entry.share, entry.count / 10);
    }
});
