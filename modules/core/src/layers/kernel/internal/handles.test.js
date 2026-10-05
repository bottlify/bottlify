/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_HANDLE, createHandleTable } from './handles.js';

test('handles are opaque, distinct and aligned', ()=>{
    const table = createHandleTable();
    const a = table.open('event', { name: 'a' });
    const b = table.open('event', { name: 'b' });

    assert.notEqual(a, b);
    assert.equal(a % 4, 0, 'a guest treating a handle as an index or pointer breaks loudly');
    assert.equal(b % 4, 0);
    assert.notEqual(a, 0, 'zero is not a handle');
});

test('no handle is a value a brush argument means as a system colour plus one', ()=>{
    // COLOR_* + 1, up to 31: user32 reads a class background or a FillRect
    // brush at or below it as a colour, and a brush is a handle of this table.
    const table = createHandleTable();
    assert.ok(table.open('gdi', {}) > 31);
});

test('resolving returns the object, and the type can be asserted', ()=>{
    const table = createHandleTable();
    const event = { signalled: false };
    const handle = table.open('event', event);

    assert.equal(table.resolve(handle), event);
    assert.equal(table.resolve(handle, 'event'), event);
    assert.equal(table.typeOf(handle), 'event');

    assert.throws(()=>table.resolve(handle, 'mutex'), /is a event, not a mutex/,
        'a handle used as the wrong kind of object is caught here, not deeper');
});

test('an invented handle is an error, not a wrong object', ()=>{
    const table = createHandleTable();
    table.open('event', {});

    assert.throws(()=>table.resolve(0x1234), /Invalid handle 0x1234/);
    assert.throws(()=>table.resolve(0), /Invalid handle/);
    assert.equal(table.has(0x1234), false);
});

test('use after close lands on nothing, not on the next object', ()=>{
    const table = createHandleTable();
    const first = table.open('event', { name: 'first' });
    table.close(first);

    // The whole point of delaying reuse: this must not hand back a later object.
    const second = table.open('mutex', { name: 'second' });
    assert.notEqual(second, first, 'a freed handle is not reissued immediately');
    assert.throws(()=>table.resolve(first), /Invalid handle/);
});

test('closing twice is an error the caller can turn into a failure code', ()=>{
    const table = createHandleTable();
    const handle = table.open('event', {});

    assert.deepEqual(table.close(handle), {});
    assert.throws(()=>table.close(handle), /Cannot close invalid handle/);
});

test('a freed handle is reused only once the fresh range runs out', ()=>{
    // A deliberately tiny range, so exhaustion is reachable in a test.
    const table = createHandleTable({ limit: FIRST_HANDLE + 8 });
    const handles = [table.open('event', 1), table.open('event', 2), table.open('event', 3)];
    assert.deepEqual(handles, [FIRST_HANDLE, FIRST_HANDLE + 4, FIRST_HANDLE + 8]);

    table.close(handles[0]);
    table.close(handles[1]);

    // Fresh handles are gone, so closed ones come back — in the order they closed.
    assert.equal(table.open('event', 4), handles[0]);
    assert.equal(table.open('event', 5), handles[1]);
    assert.equal(table.resolve(handles[0]), 4);

    assert.throws(()=>table.open('event', 6), /Handle table exhausted/,
        'running out is an error, not a silently duplicated handle');
});

test('diagnostics account for every handle', ()=>{
    const table = createHandleTable();
    const a = table.open('thread', {});
    table.open('event', {});
    table.open('event', {});
    table.close(a);

    const diag = table.diagnostics();
    assert.equal(diag.open, 2);
    assert.equal(diag.opened, 3);
    assert.equal(diag.closed, 1);
    assert.equal(diag.pendingReuse, 1);
    assert.deepEqual(diag.byType, { event: 2 });
    assert.deepEqual(table.list().map(e=>e.type), ['event', 'event']);
});
