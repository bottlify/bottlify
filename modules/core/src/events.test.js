/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvents } from './events.js';

test('handlers run in registration order until one answers', ()=>{
    const events = createEvents();
    /** @type {string[]} */
    const ran = [];

    events.on('debug', ()=>{
        ran.push('first');
    });
    events.on('debug', ()=>{
        ran.push('second');
        return 'handled';
    });
    events.on('debug', ()=>{
        ran.push('third');
    });

    assert.equal(events.emit('debug', { text: 'x' }), 'handled');
    assert.deepEqual(ran, ['first', 'second'], 'the answer stops the rest');
});

test('returning nothing is watching, not intervening', ()=>{
    const events = createEvents();
    /** @type {any[]} */
    const seen = [];
    events.on('output', payload=>{
        seen.push(payload);
    });

    assert.equal(events.emit('output', { handle: 2, text: 'hi' }), undefined);
    assert.deepEqual(seen, [{ handle: 2, text: 'hi' }]);
});

test('a handler that answers with something falsy has still answered', ()=>{
    const events = createEvents();
    // Swallowing is answering: a consumer that wants an event dropped says so
    // with a value, and 0, false and null are values. Only `undefined` is not.
    events.on('debug', ()=>false);
    events.on('debug', ()=>{
        throw new Error('the first handler already decided');
    });

    assert.equal(events.emit('debug', {}), false);
});

test('subscribing hands back the way to stop', ()=>{
    const events = createEvents();
    let calls = 0;
    const stop = events.on('exit', ()=>{
        calls++;
    });

    events.emit('exit', { code: 0 });
    stop();
    events.emit('exit', { code: 0 });
    stop(); // twice is harmless

    assert.equal(calls, 1);
    assert.equal(events.listening('exit'), false);
});

test('a handler that unsubscribes during an emit does not disturb it', ()=>{
    const events = createEvents();
    /** @type {string[]} */
    const ran = [];
    /** @type {() => void} */
    let stopSecond = ()=>{};

    events.on('error', ()=>{
        ran.push('first');
        stopSecond();
    });
    stopSecond = events.on('error', ()=>{
        ran.push('second');
    });

    events.emit('error', {});
    assert.deepEqual(ran, ['first', 'second'],
        'the list in flight is the one that was there when the emit began');
    events.emit('error', {});
    assert.deepEqual(ran, ['first', 'second', 'first']);
});

test('an event nobody listens for is not an error', ()=>{
    const events = createEvents();
    assert.equal(events.emit('nothing-here', {}), undefined);
    assert.equal(events.listening('nothing-here'), false);
    assert.deepEqual(events.diagnostics().emitted, { 'nothing-here': 1 });
});

test('a watcher sees every event and decides nothing', ()=>{
    // Watching and intercepting are the same mechanism here, which makes it
    // possible to add a watcher that accidentally answers -- and an event
    // answered by the journal is an event a real handler never sees.
    const events = createEvents();
    /** @type {[string, any][]} */
    const seen = [];
    events.onAny((name, payload)=>{
        seen.push([name, payload]);
        return 'this must be ignored';
    });
    events.on('output', ()=>'the handler decides');

    assert.equal(events.emit('output', { text: 'hi' }), 'the handler decides');
    assert.equal(events.emit('exit', { code: 0 }), undefined);
    assert.deepEqual(seen, [['output', { text: 'hi' }], ['exit', { code: 0 }]]);
});

test('a watcher that throws does not stop the event', ()=>{
    const events = createEvents();
    events.onAny(()=>{
        throw new Error('the journal is having a bad day');
    });
    let reached = false;
    events.on('exit', ()=>{
        reached = true;
    });

    events.emit('exit', { code: 0 });
    assert.ok(reached, 'the program\'s own handling is not the watcher\'s to break');
});

test('a watcher can be removed', ()=>{
    const events = createEvents();
    let count = 0;
    const stop = events.onAny(()=>{
        count++;
    });

    events.emit('exit', {});
    stop();
    events.emit('exit', {});
    assert.equal(count, 1);
});
