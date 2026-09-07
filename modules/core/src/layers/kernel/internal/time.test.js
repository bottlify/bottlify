/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from './time.js';

/** A host clock we control, so intervals are exact rather than approximate. */
function fakeHostClock(){
    let ms = 1000;
    return {
        now: ()=>ms,
        /** @param {number} by */
        pass: by=>{
            ms += by;
        },
    };
}

test('the guest clock advances with the guest', ()=>{
    const clock = createClock({ now: fakeHostClock().now });
    clock.advance(16);
    clock.advance(16);
    assert.equal(clock.virtualTime(), 32);
});

test('time spent in our code is credited to the guest', ()=>{
    const host = fakeHostClock();
    const clock = createClock({ now: host.now });

    clock.suspend();
    host.pass(5); // a trap handler runs for 5 ms of wall time
    assert.equal(clock.resume(), 5);

    // Without this the guest would conclude the interval took nothing at all,
    // and a program pacing itself by elapsed time speeds up.
    assert.equal(clock.virtualTime(), 5);
});

test('a very short interval is not worth crediting', ()=>{
    const host = fakeHostClock();
    const clock = createClock({ now: host.now, floorMs: 0.5 });

    clock.suspend();
    host.pass(0.1);
    assert.equal(clock.resume(), 0, 'sub-millisecond noise on every trap would drift the clock');
    assert.equal(clock.virtualTime(), 0);
    assert.equal(clock.diagnostics().ignored, 1);
});

test('a long stall is credited, but capped', ()=>{
    const host = fakeHostClock();
    const clock = createClock({ now: host.now, ceilingMs: 16 });

    clock.suspend();
    host.pass(1000); // something on the host took a whole second
    assert.equal(clock.resume(), 16, 'the guest is told about 16 ms, not 1000');

    // Handing over the whole second would make one frame look a thousand times
    // slower than any real one, and code that scales by elapsed time reacts to
    // that violently.
    assert.equal(clock.virtualTime(), 16);
    assert.equal(clock.diagnostics().capped, 1);
});

test('resuming without suspending credits nothing', ()=>{
    const clock = createClock({ now: fakeHostClock().now });
    assert.equal(clock.resume(), 0);
    assert.equal(clock.virtualTime(), 0);
});

test('diagnostics show the two clocks side by side', ()=>{
    const host = fakeHostClock();
    const clock = createClock({ now: host.now, ceilingMs: 16 });

    clock.advance(32);
    clock.suspend();
    host.pass(100);
    clock.resume();

    const diag = clock.diagnostics();
    assert.equal(diag.virtualMs, 48, '32 of guest time plus a capped 16');
    assert.equal(diag.wallMs, 100);
    assert.equal(diag.capped, 1,
        'capping often means the host stalls longer than the guest can be told');
});
