/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GC_NUDGE, gcNudgeOf, runsJavaScriptCore, startGcNudge } from './gc-nudge.js';

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
