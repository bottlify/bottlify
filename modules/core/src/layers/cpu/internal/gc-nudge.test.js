/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GC_NUDGE, gcNudgeOf, nudgeWhenAsked, runsJavaScriptCore, startGcNudge }
    from './gc-nudge.js';

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/141.0.0.0`;
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';

test('JavaScriptCore is told by the agent: Safari and every iOS browser, not Blink', ()=>{
    assert.equal(runsJavaScriptCore(SAFARI), true);
    assert.equal(runsJavaScriptCore(CHROME_IOS), true);
    assert.equal(runsJavaScriptCore(CHROME), false);
    assert.equal(runsJavaScriptCore(EDGE), false);
    assert.equal(runsJavaScriptCore(FIREFOX), false);
    assert.equal(runsJavaScriptCore('Node.js/22'), false);
});

test('a run is nudged by default only on JavaScriptCore, and as it asks otherwise', ()=>{
    assert.deepEqual(gcNudgeOf(undefined, SAFARI), { ...GC_NUDGE });
    assert.equal(gcNudgeOf(undefined, CHROME), null);
    assert.equal(gcNudgeOf(false, SAFARI), null);
    assert.deepEqual(gcNudgeOf(true, CHROME), { ...GC_NUDGE });
    assert.deepEqual(gcNudgeOf({ everyMs: 20 }, CHROME), { everyMs: 20, bytes: GC_NUDGE.bytes });
});

test('the default buffer is a quarter of the guest memory past 256 MB, and never less', ()=>{
    const MB = 1024 * 1024;
    assert.equal(gcNudgeOf(undefined, SAFARI, 128 * MB)?.bytes, GC_NUDGE.bytes);
    assert.equal(gcNudgeOf(undefined, SAFARI, 256 * MB)?.bytes, 64 * MB);
    assert.equal(gcNudgeOf(undefined, SAFARI, 2048 * MB)?.bytes, 512 * MB);
    assert.equal(gcNudgeOf({ bytes: MB }, SAFARI, 2048 * MB)?.bytes, MB, 'as asked');
});

test('a poke makes a buffer only once a period has passed since the last', ()=>{
    let time = 0;
    /** @type {(() => void) | null} */
    let tick = null;
    const nudge = startGcNudge({ everyMs: 50, bytes: 1024 }, {
        every: run=>{
            tick = run;
            return 'timer';
        },
        cancel: ()=>{},
        now: ()=>time,
    });
    time = 30;
    nudge.poke();
    assert.equal(nudge.made(), 0, 'too soon');
    time = 50;
    nudge.poke();
    assert.equal(nudge.made(), 1);
    time = 80;
    /** @type {() => void} */ (/** @type {unknown} */ (tick))();
    assert.equal(nudge.made(), 2, 'the timer still makes one');
    time = 120;
    nudge.poke();
    assert.equal(nudge.made(), 2, 'the period counts from the timer\'s');
    time = 130;
    nudge.poke();
    assert.equal(nudge.made(), 3);
});

test('a buffer the browser will not make is counted and does not end the run', ()=>{
    let time = 0;
    /** @type {(() => void) | null} */
    let tick = null;
    // Past what any engine allocates: the RangeError an iPhone's gave near its limit.
    const nudge = startGcNudge({ everyMs: 50, bytes: Number.MAX_SAFE_INTEGER }, {
        every: run=>{
            tick = run;
            return 'timer';
        },
        cancel: ()=>{},
        now: ()=>time,
    });
    time = 50;
    assert.doesNotThrow(()=>nudge.poke());
    /** @type {() => void} */ (/** @type {unknown} */ (tick))();
    assert.equal(nudge.made(), 0);
    assert.equal(nudge.refused(), 2);
    time = 70;
    nudge.poke();
    assert.equal(nudge.refused(), 2, 'a refusal waits its period as a buffer made does');
});

test('the nudge makes a buffer at each tick until it is stopped', ()=>{
    /** @type {(() => void) | null} */
    let tick = null;
    let cancelled = null;
    const nudge = startGcNudge({ everyMs: 50, bytes: 1024 }, {
        every: (run, ms)=>{
            assert.equal(ms, 50);
            tick = run;
            return 'timer';
        },
        cancel: timer=>{
            cancelled = timer;
        },
    });
    assert.equal(nudge.made(), 0);
    /** @type {() => void} */ (/** @type {unknown} */ (tick))();
    /** @type {() => void} */ (/** @type {unknown} */ (tick))();
    assert.equal(nudge.made(), 2);
    nudge.stop();
    assert.equal(cancelled, 'timer');
});

test('a worker is nudged from the first message that asks, and once', ()=>{
    /** @type {((event: { data: any }) => void) | null} */
    let listener = null;
    /** @type {(() => void)[]} */
    const ticks = [];
    const nudge = nudgeWhenAsked({ addEventListener: (type, listen)=>{
        assert.equal(type, 'message');
        listener = listen;
    } }, { every: run=>ticks.push(run), cancel: ()=>{} });
    const send = (/** @type {any} */ data)=>
        /** @type {(event: { data: any }) => void} */ (/** @type {unknown} */ (listener))({ data });
    send({ type: 'open' });
    send(null);
    assert.equal(ticks.length, 0, 'nothing started unasked');
    send({ type: 'open', gcNudge: { everyMs: 50, bytes: 1024 } });
    send({ type: 'open', gcNudge: { everyMs: 50, bytes: 1024 } });
    assert.equal(ticks.length, 1, 'one nudge for the worker');
    ticks[0]();
    assert.equal(nudge.made(), 1);
});
