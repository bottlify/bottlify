/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_WINDOW, WM_QUIT, createMessageQueue } from './messages.js';

const WM_KEYDOWN = 0x0100;
const WM_MOUSEMOVE = 0x0200;
const WM_USER = 0x0400;

/** The filter that admits everything, spelled out once. */
const ALL = { hwnd: ANY_WINDOW, first: 0, last: 0, remove: true };

test('a posted message comes back with the fields it was posted with', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 0x40, message: WM_USER, wParam: 1, lParam: 2, time: 99, x: 3, y: 4 });

    assert.deepEqual(queue.peek(ALL), {
        hwnd: 0x40, message: WM_USER, wParam: 1, lParam: 2, time: 99, x: 3, y: 4,
    });
    assert.equal(queue.depth(), 0, 'a removed message is gone');
});

test('an injected message defaults the fields the injector did not supply', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 0, message: WM_KEYDOWN, wParam: 0x41, lParam: 0 });

    assert.deepEqual(queue.peek(ALL), {
        hwnd: 0, message: WM_KEYDOWN, wParam: 0x41, lParam: 0, time: 0, x: 0, y: 0,
    });
});

test('an empty queue answers with nothing rather than a placeholder', ()=>{
    const queue = createMessageQueue();
    assert.equal(queue.peek(ALL), null);
});

test('messages come back in the order they were posted', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: 1, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: 2, wParam: 0, lParam: 0 });

    assert.equal(queue.peek(ALL)?.message, 1);
    assert.equal(queue.peek(ALL)?.message, 2);
});

test('a peek that does not remove leaves the message where it was', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });

    const looked = queue.peek({ ...ALL, remove: false });
    assert.equal(looked?.message, WM_USER);
    assert.equal(queue.depth(), 1, 'looking is not taking');
    assert.equal(queue.peek(ALL)?.message, WM_USER, 'and the same message is still next');
});

test('the window filter skips messages belonging to another window', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 8, message: WM_USER, wParam: 0, lParam: 0 });

    assert.equal(queue.peek({ ...ALL, hwnd: 8 })?.hwnd, 8);
    assert.equal(queue.depth(), 1, 'the one that did not match stayed');
    assert.equal(queue.peek({ ...ALL, hwnd: 8 }), null);
    assert.equal(queue.peek({ ...ALL, hwnd: 4 })?.hwnd, 4);
});

test('a message range admits only what falls inside it', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: WM_KEYDOWN, wParam: 0, lParam: 0 });

    const filter = { ...ALL, first: 0x0100, last: 0x0108 };
    assert.equal(queue.peek(filter)?.message, WM_KEYDOWN);
    assert.equal(queue.peek(filter), null);
    assert.equal(queue.depth(), 1, 'the mouse message is still queued for whoever wants it');
});

test('WM_QUIT surfaces only once nothing else is left', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.postQuit(7);

    assert.equal(queue.peek(ALL)?.message, WM_USER, 'pending work is drained first');
    const quit = queue.peek(ALL);
    assert.equal(quit?.message, WM_QUIT);
    assert.equal(quit?.wParam, 7, 'the exit code rides in wParam');
    assert.equal(quit?.hwnd, 0, 'a quit belongs to the thread, not to a window');
});

test('a quit that was only looked at is still pending', ()=>{
    const queue = createMessageQueue();
    queue.postQuit(0);

    assert.equal(queue.peek({ ...ALL, remove: false })?.message, WM_QUIT);
    assert.ok(queue.quitPending(), 'PM_NOREMOVE does not consume the quit');
    assert.equal(queue.peek(ALL)?.message, WM_QUIT);
    assert.equal(queue.quitPending(), false);
    assert.equal(queue.peek(ALL), null, 'and it is not delivered twice');
});

test('a filtered peek does not steal a quit it did not ask for', ()=>{
    const queue = createMessageQueue();
    queue.postQuit(0);

    assert.equal(queue.peek({ ...ALL, first: 0x0100, last: 0x0108 }), null);
    assert.ok(queue.quitPending());
});

test('purging a window drops its messages and nobody else\'s', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 8, message: WM_USER, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });

    queue.purge(4);

    assert.equal(queue.depth(), 1);
    assert.equal(queue.peek(ALL)?.hwnd, 8);
});
