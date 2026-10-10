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
    listen, scheduleKeyTimes, schedulePresses, presentFrame, recordSample, resetSamples, profile,
    byModule, guestSamples, seedFiles, bundleStoreOptions,
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

test('a click at a moment lands in input.send, where the pointer is, then lets go', async()=>{
    const app = fakeApp();
    scheduleKeyTimes(app, { clickTimes: [{ x: 375, y: 306, atMs: 5, holdMs: 10 }] });

    await new Promise(resolve=>setTimeout(resolve, 40));

    assert.deepEqual(app.sent, [
        { kind: 'pointerMove', x: 375, y: 306, dx: 0, dy: 0 },
        { kind: 'pointerButton', button: 'left', down: true },
        { kind: 'pointerButton', button: 'left', down: false },
    ]);
});

test('a wizard\'s button is pressed by its label once the screen settles, the first label'
    + ' the screen carries first', async t=>{
    const app = fakeApp();
    /** @param {string} hwnd @param {string} title @param {object} [more] */
    const button = (hwnd, title, more = {})=>({ hwnd, parent: '0x10', child: true,
        visible: true, enabled: true, className: 'Button', title, style: '0x50010000',
        rect: { left: 100, top: 200, right: 180, bottom: 224 }, ...more });
    const windows = [
        { hwnd: '0x10', parent: null, child: false, visible: true, enabled: true,
            className: '#32770', title: 'Setup', style: '0x94c808cc',
            rect: { left: 0, top: 0, right: 400, bottom: 300 } },
        button('0x20', '&Next >', { rect: { left: 300, top: 260, right: 380, bottom: 284 } }),
        button('0x24', 'Install', { enabled: false }),
        button('0x28', 'I &agree', { style: '0x50010003' }),
        button('0x2c', 'Finish', { parent: '0x30' }),
    ];
    /** @type {any} */ (app).debug = { windows: ()=>windows };
    /** @type {string[]} */
    const said = [];
    const stop = schedulePresses(app, { presses: ['finish', 'install', 'i agree', 'next >'],
        pressSettleMs: 10, pressEveryMs: 5 }, line=>said.push(line));
    t.after(stop);
    for (let waited = 0; said.length < 3 && waited < 2000; waited += 10)
    {
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    stop();
    await new Promise(resolve=>setTimeout(resolve, 150));

    assert.equal(said[0], 'press "I &agree" at 140,212', 'Finish has no parent on the'
        + ' screen and Install is disabled; a label listed before Next goes first');
    assert.deepEqual(said.slice(1, 3), ['press "&Next >" at 340,272',
        'press "&Next >" at 340,272'], 'the check box once, as it toggles, and a push button'
        + ' the program did not take pressed again');
    assert.deepEqual(app.sent.slice(0, 2), [
        { kind: 'pointerMove', x: 140, y: 212, dx: 0, dy: 0 },
        { kind: 'pointerButton', button: 'left', down: true },
    ]);
    const buttons = app.sent.filter(message=>message.kind === 'pointerButton');
    assert.equal(buttons.filter(message=>!message.down).length,
        buttons.filter(message=>message.down).length, 'and every press is let go');
});

test('a button inside a window a modal box disabled is not pressed; the box\'s is', async t=>{
    const app = fakeApp();
    const windows = [
        { hwnd: '0x10', parent: null, child: false, visible: true, enabled: false,
            className: 'TWizardForm', title: 'Setup', rect: { left: 0, top: 0, right: 400,
                bottom: 300 } },
        { hwnd: '0x20', parent: '0x10', child: true, visible: true, enabled: true,
            className: 'Button', title: '&Next >', style: '0x50010000',
            rect: { left: 300, top: 260, right: 380, bottom: 284 } },
        { hwnd: '0x30', parent: '0x10', child: false, visible: true, enabled: true,
            className: '#32770', title: 'Folder', rect: { left: 50, top: 50, right: 350,
                bottom: 200 } },
        { hwnd: '0x34', parent: '0x30', child: true, visible: true, enabled: true,
            className: 'Button', title: '&Yes', style: '0x50010000',
            rect: { left: 100, top: 150, right: 180, bottom: 174 } },
    ];
    /** @type {any} */ (app).debug = { windows: ()=>windows };
    /** @type {string[]} */
    const said = [];
    const stop = schedulePresses(app, { presses: ['next >', 'yes'], pressSettleMs: 10,
        pressEveryMs: 5 }, line=>said.push(line));
    t.after(stop);
    for (let waited = 0; said.length < 1 && waited < 2000; waited += 10)
    {
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    stop();
    assert.equal(said[0], 'press "&Yes" at 140,162',
        'Next is listed first, but its window is disabled behind the box');
});

test('a presented frame increments the counter and records the gap', ()=>{
    const app = fakeApp();
    /** @type {import('./harness.js').PresentState} */
    const state = { presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], times: [], lastPresent: 0, presents: 0 };
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
        gaps: [], times: [], lastPresent: 0, presents: 0 };
    const request = {
        pointer: { x: 12, y: 34 },
        clicks: [{ x: 50, y: 60, after: 1 }],
        keys: [{ code: 'Enter', after: 1 }],
    };

    presentFrame(app, request, state, {}); // presents === 1
    assert.deepEqual(app.sent[0], { kind: 'pointerMove', x: 12, y: 34, dx: 0, dy: 0 },
        'the held pointer is placed every frame');

    // Then in turn: the click's corner, its move and press, its release; the
    // key's press and release.
    for (let frame = 2; frame <= 6; frame++)
    {
        presentFrame(app, request, state, {});
    }
    const steps = (state.inputs ?? []).filter(sent=>sent.kind !== 'pointerMove'
        || sent.dx !== 0).map(sent=>`${sent.present}:${sent.kind}:${sent.down ?? ''}`);
    assert.deepEqual(steps, ['1:pointerMove:', '2:pointerMove:', '2:pointerButton:true',
        '3:pointerButton:false', '4:key:true', '5:key:false']);
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

test('guestSamples names the cpu layer\'s raw buckets against the module layout', ()=>{
    const layout = ['Game.dll 4096+4096', 'Other.dll 8192+4096'];
    const named = guestSamples({
        slices: 12,
        overflow: 2,
        top: [
            { address: 4096 + 10, instructions: 500, samples: 3 },
            { address: 8192 + 5, instructions: 300, samples: 2 },
        ],
    }, layout);

    assert.equal(named.slices, 12);
    assert.equal(named.overflow, 2);
    assert.deepEqual(named.top, [
        { at: 'Game.dll+0xa', instructions: 500, samples: 3 },
        { at: 'Other.dll+0x5', instructions: 300, samples: 2 },
    ]);
});

test('guestSamples answers null without a sampler to report', ()=>{
    assert.equal(guestSamples(undefined, []), null);
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

test('a plain request keeps no bundle store, and a warm-store request names one', ()=>{
    assert.deepEqual(bundleStoreOptions({}), { store: null, prefetch: false, id: undefined },
        'unset means no cache, same as before this request field existed');
    assert.deepEqual(
        bundleStoreOptions({ store: 'local', prefetch: true, bundleId: 'some-title' }),
        { store: 'local', prefetch: true, id: 'some-title' });
});

test('a seeded file reaches the volume as the bytes it was, at the path it was given', ()=>{
    const bytes = new Uint8Array([0, 0x80, 0x9d, 0xff, 0x41]);
    const [file] = seedFiles([{
        path: 'C:\\App\\base\\demos\\bench.demo',
        base64: Buffer.from(bytes).toString('base64'),
    }]);
    assert.equal(file.path, 'C:\\App\\base\\demos\\bench.demo');
    assert.deepEqual([...file.bytes], [...bytes]);
});

test('a route\'s clicks move a cursor kept by relative motion to where they are aimed', ()=>{
    // DirectInput's mouse: the program starts its cursor in the middle, adds
    // every motion to it, stops it at the screen's edges, and puts it back
    // in the middle whenever it likes.
    const app = fakeApp();
    /** @type {import('./harness.js').PresentState} */
    const state = { presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], times: [], lastPresent: 0, firstPresent: 0, presents: 0 };
    const request = { clicks: [{ x: 672, y: 528, after: 2 }, { x: 132, y: 174, after: 5 }] };
    const cursor = { x: 512, y: 384 };
    /** @type {{ x: number, y: number }[]} */
    const pressedAt = [];
    /** @param {any[]} messages */
    const take = messages=>{
        for (const message of messages)
        {
            if (message.kind === 'pointerMove')
            {
                cursor.x = Math.min(1023, Math.max(0, cursor.x + message.dx));
                cursor.y = Math.min(767, Math.max(0, cursor.y + message.dy));
            }
            if (message.kind === 'pointerButton' && message.down)
            {
                pressedAt.push({ ...cursor });
            }
        }
    };
    for (let frame = 0; frame < 8; frame++)
    {
        if (frame === 4)
        {
            cursor.x = 512;
            cursor.y = 384;
        }
        const from = app.sent.length;
        presentFrame(app, request, state, {});
        take(app.sent.slice(from));
    }
    assert.deepEqual(pressedAt, [{ x: 672, y: 528 }, { x: 132, y: 174 }]);
    assert.equal(state.inputs?.filter(sent=>sent.kind === 'pointerButton').length, 4,
        'every press and release is in the record');
});

test('timed clicks that come due on the same present go one after the other', ()=>{
    // The first present came before a load that held the screen past both.
    const app = fakeApp();
    /** @type {import('./harness.js').PresentState} */
    const state = { presented: null, pointerDown: false, pointerAt: { x: 0, y: 0 },
        gaps: [], times: [], lastPresent: 0, firstPresent: 0, presents: 0 };
    const request = { clicks: [{ x: 10, y: 10, after: -1, afterSeconds: 0 },
        { x: 20, y: 20, after: -1, afterSeconds: 0 }] };
    for (let frame = 0; frame < 8; frame++)
    {
        presentFrame(app, request, state, {});
    }
    const buttons = (state.inputs ?? []).filter(sent=>sent.kind === 'pointerButton')
        .map(sent=>`${sent.present}:${sent.down ? 'down' : 'up'}`);
    assert.deepEqual(buttons, ['2:down', '3:up', '5:down', '6:up']);
});
