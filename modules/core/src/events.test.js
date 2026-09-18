/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvents, REPLAY_LIMIT } from './events.js';

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

test('an event emitted before anyone subscribed still reaches the first subscriber, '
    + 'in order with a live one', ()=>{
    // What `buildApp` does to `hooks-bound` and the rest: emit before a
    // caller's `createApp(...)` promise has even settled, so the caller's
    // first `on()` for that name always arrives after the fact.
    const events = createEvents();
    /** @type {any[]} */
    const seen = [];

    events.emit('hooks-bound', { bound: ['a'], refused: [] });
    events.on('hooks-bound', payload=>seen.push(payload));
    events.emit('hooks-bound', { bound: ['b'], refused: [] });

    assert.deepEqual(seen, [
        { bound: ['a'], refused: [] },
        { bound: ['b'], refused: [] },
    ], 'the missed emission arrives first, then the live one, in order');
});

test('a second subscriber to the same name gets only what is live from then on', ()=>{
    const events = createEvents();
    /** @type {any[]} */
    const first = [];
    /** @type {any[]} */
    const second = [];

    events.emit('libraries', { loaded: ['a'], missing: [] });
    // `push`'s return (the new length) is not `undefined`, and this registry's
    // `emit` treats a handler's non-`undefined` return as "handled, stop
    // here" -- so a block body is used, not an arrow expression, to keep the
    // handler a watcher rather than an accidental interceptor.
    events.on('libraries', payload=>{ first.push(payload); });
    events.on('libraries', payload=>{ second.push(payload); });
    events.emit('libraries', { loaded: ['b'], missing: [] });

    assert.deepEqual(first, [
        { loaded: ['a'], missing: [] },
        { loaded: ['b'], missing: [] },
    ], 'the first subscriber got the replay');
    assert.deepEqual(second, [{ loaded: ['b'], missing: [] }],
        'the second subscriber, to the same name, only ever sees the live one');
});

test('what nobody has subscribed to yet is kept only up to REPLAY_LIMIT per name', ()=>{
    const events = createEvents();
    for (let at = 0; at < REPLAY_LIMIT + 1; at++)
    {
        events.emit('library-loaded', { name: `dll${at}` });
    }
    /** @type {any[]} */
    const seen = [];
    events.on('library-loaded', payload=>seen.push(payload));

    assert.equal(seen.length, REPLAY_LIMIT, 'the oldest one, past the bound, was dropped');
    assert.equal(seen[0].name, 'dll1', 'dll0 is the one the bound dropped');
    assert.equal(seen[seen.length - 1].name, `dll${REPLAY_LIMIT}`);
});
