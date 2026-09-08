/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANY_WINDOW, WM_QUIT, WM_TIMER, createMessageQueue } from './messages.js';

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

// --- timers ---

/** A queue over a clock a test moves by hand, in guest milliseconds. */
function timed(){
    const clock = { at: 0 };
    return { clock, queue: createMessageQueue({ now: ()=>clock.at }) };
}

test('a timer becomes a message only once it is due', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 50, 0);

    assert.equal(queue.peek(ALL), null, 'nothing is due yet');
    clock.at = 49;
    assert.equal(queue.peek(ALL), null);

    clock.at = 50;
    assert.deepEqual(queue.peek(ALL), {
        hwnd: 0x40, message: WM_TIMER, wParam: 1, lParam: 0, time: 50, x: 0, y: 0,
    });
});

test('a due timer does not hand out the same tick for ever', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 50, 0);

    clock.at = 50;
    assert.ok(queue.peek(ALL), 'the first tick');
    assert.equal(queue.peek(ALL), null, 'and no second one at the same instant');

    clock.at = 100;
    assert.ok(queue.peek(ALL), 'the next period comes due on its own');
});

test('a slow handler does not build a backlog of ticks', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);

    // Ten periods pass inside one handler. Windows makes a WM_TIMER up when
    // asked rather than queueing them, so what comes back is one tick, not ten.
    clock.at = 100;
    assert.ok(queue.peek(ALL));
    assert.equal(queue.peek(ALL), null);
});

test('a queued message outranks a due timer', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);
    queue.post({ hwnd: 0x40, message: WM_USER, wParam: 0, lParam: 0 });
    clock.at = 100;

    assert.equal(queue.peek(ALL)?.message, WM_USER, 'the queue is consulted first');
    assert.equal(queue.peek(ALL)?.message, WM_TIMER, 'and the timer after it');
});

test('a TIMERPROC travels in lParam, which is where DispatchMessage looks', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0, 7, 10, 0x401000);
    clock.at = 10;

    assert.equal(queue.peek(ALL)?.lParam, 0x401000,
        'a timer with no window has nowhere else to go');
});

test('killing a timer stops it, and killing an unknown one says so', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);

    assert.equal(queue.killTimer(0x40, 1), true);
    assert.equal(queue.killTimer(0x40, 1), false, 'the second kill finds nothing');
    clock.at = 1000;
    assert.equal(queue.peek(ALL), null);
});

test('a destroyed window takes its timers with it', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);
    queue.setTimer(0x40, 2, 10, 0);
    queue.setTimer(0x80, 3, 10, 0);

    queue.killTimersFor(0x40);
    clock.at = 1000;

    assert.equal(queue.peek(ALL)?.hwnd, 0x80, 'only the surviving window ticks');
    assert.equal(queue.peek(ALL), null);
});

test('nextDue reports the earliest timer, so an idle wait knows how long', ()=>{
    const { queue } = timed();
    assert.equal(queue.nextDue(), null, 'nothing to wait for');

    queue.setTimer(0x40, 1, 500, 0);
    queue.setTimer(0x40, 2, 30, 0);
    assert.equal(queue.nextDue(), 30);
});

test('a zero period is clamped rather than firing continuously', ()=>{
    const { queue } = timed();
    queue.setTimer(0x40, 1, 0, 0);

    assert.equal(queue.nextDue(), 10, 'as often as we can, not as often as asked');
});

test('a filtered peek does not synthesise a timer it did not ask for', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);
    clock.at = 100;

    assert.equal(queue.peek({ ...ALL, first: WM_KEYDOWN, last: WM_KEYDOWN }), null);
    assert.ok(queue.peek(ALL), 'and the tick is still there for a peek that does');
});
