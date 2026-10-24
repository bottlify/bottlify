/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ANY_WINDOW, QS_KEY, QS_MOUSEBUTTON, QS_MOUSEMOVE, QS_PAINT, QS_POSTMESSAGE, QS_TIMER,
    WM_QUIT, WM_TIMER, createMessageQueue,
} from './messages.js';

const WM_KEYDOWN = 0x0100;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
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

test('a key is held as of the key message taken, not as the keys are now', ()=>{
    // A paste's chord is Control down, V down, V up, Control up, all at once:
    // by the time the program takes the V, Control is already up on the
    // keyboard, and TranslateMessage must still read it as held.
    const queue = createMessageQueue();
    assert.equal(queue.heldAsOfMessage(0x11), null, 'nothing taken yet');
    for (const [message, wParam] of [[WM_KEYDOWN, 0x11], [WM_KEYDOWN, 0x56],
        [0x0101, 0x56], [0x0101, 0x11]])
    {
        queue.post({ hwnd: 0, message, wParam, lParam: 0 });
    }
    queue.peek(ALL);
    queue.peek(ALL);
    assert.equal(queue.heldAsOfMessage(0x11), true, 'Control, as of the V');
    assert.equal(queue.heldAsOfMessage(0x56), true);
    queue.peek(ALL);
    queue.peek(ALL);
    assert.equal(queue.heldAsOfMessage(0x11), false);
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

test('a timer set after a look is handed out when due, though one set before is due later', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 1000, 0);
    // The look learns that nothing is due before 1000.
    assert.equal(queue.peek(ALL), null);

    queue.setTimer(0x40, 2, 10, 0);
    clock.at = 10;
    assert.equal(queue.peek(ALL)?.wParam, 2, 'the new timer is not hidden behind the old one');
    clock.at = 20;
    assert.equal(queue.peek(ALL)?.wParam, 2, 'and its next tick comes in its own period');
});

test('a timer killed before its tick leaves the next one due when it is due', ()=>{
    const { clock, queue } = timed();
    queue.setTimer(0x40, 1, 10, 0);
    queue.setTimer(0x40, 2, 30, 0);
    assert.equal(queue.peek(ALL), null);
    queue.killTimer(0x40, 1);

    clock.at = 10;
    assert.equal(queue.peek(ALL), null, 'the killed timer hands out nothing');
    clock.at = 30;
    assert.equal(queue.peek(ALL)?.wParam, 2);
});

test('whether anything posted waits is said without taking it', ()=>{
    const queue = createMessageQueue();
    assert.equal(queue.hasQueued(null), false);
    queue.post({ hwnd: 0x40, message: 0x400, wParam: 0, lParam: 0 });
    assert.equal(queue.hasQueued(null), true);
    assert.equal(queue.hasQueued(null), true, 'asking twice takes nothing');
    assert.ok(queue.peek(ALL));
    assert.equal(queue.hasQueued(null), false);
});

/** A queue whose pump is run by one thread or another, as a test says. */
function threaded(){
    const clock = { at: 0 };
    const first = { id: 1, name: 'first', state: 'running' };
    const second = { id: 2, name: 'second', state: 'running' };
    const running = { thread: /** @type {any} */ (first) };
    const queue = createMessageQueue({ now: ()=>clock.at, currentThread: ()=>running.thread });
    return { clock, queue, first, second, running };
}

test('a timer with no window is its thread\'s: another thread\'s pump is not handed it', ()=>{
    const { clock, queue, first, second, running } = threaded();
    queue.setTimer(0, 9, 50, 0);
    clock.at = 50;

    running.thread = second;
    assert.equal(queue.peek(ALL), null);
    assert.equal(queue.hasTimer(0, 9), false, 'nor does it see it as set');

    running.thread = first;
    assert.equal(queue.peek(ALL)?.wParam, 9, 'the thread that set it is');
});

test('a window\'s timer goes to whichever thread pumps', ()=>{
    const { clock, queue, second, running } = threaded();
    queue.setTimer(0x40, 1, 50, 0);
    clock.at = 50;
    running.thread = second;
    assert.equal(queue.peek(ALL)?.hwnd, 0x40);
});

test('a window\'s messages and its timer wait for the thread that made the window', ()=>{
    const { clock, queue, first, second, running } = threaded();
    queue.ownersFrom(hwnd=>(hwnd === 0x40 ? second.id : first.id));
    queue.post({ hwnd: 0x40, message: WM_USER, wParam: 0, lParam: 0 });
    queue.setTimer(0x40, 1, 50, 0);
    clock.at = 50;

    assert.equal(queue.peek(ALL), null, 'the main thread is handed neither');
    assert.equal(queue.status().inQueue, 0, 'nor sees them waiting');
    assert.equal(queue.peek({ ...ALL, thread: second.id })?.message, WM_USER,
        'the thread named is handed them');
    running.thread = second;
    assert.equal(queue.status().inQueue & QS_TIMER, QS_TIMER);
    assert.equal(queue.peek(ALL)?.message, WM_TIMER);
});

test('a thread\'s message and its quit are that thread\'s alone', ()=>{
    const { queue, first, second, running } = threaded();
    queue.post({ hwnd: 0, message: WM_USER, wParam: 0, lParam: 0, thread: second.id });
    queue.postQuit(3);

    running.thread = second;
    assert.equal(queue.peek(ALL)?.message, WM_USER);
    assert.equal(queue.peek(ALL), null, 'the quit the main thread posted is not this one\'s');
    assert.equal(queue.quitPending(), true);

    running.thread = first;
    const quit = queue.peek(ALL);
    assert.equal(quit?.message, WM_QUIT);
    assert.equal(quit?.wParam, 3);
    assert.equal(queue.quitPending(), false);
});

test('a message with no window is the poster\'s own, and news is each thread\'s', ()=>{
    const { queue, second, running } = threaded();
    queue.post({ hwnd: 0, message: WM_USER, wParam: 0, lParam: 0 });

    running.thread = second;
    assert.equal(queue.news(), 0, 'nothing arrived for this thread');
    assert.equal(queue.status().changed, 0);
    assert.equal(queue.peek(ALL), null);
    assert.equal(queue.news(1), QS_POSTMESSAGE | 0x100, 'the poster has news');
    assert.equal(queue.peek({ ...ALL, thread: null })?.message, WM_USER,
        'a look naming no thread sees every queue');
});

test('a thread\'s timer ends with the thread, and no wait wakes for it again', ()=>{
    const { clock, queue, first } = threaded();
    queue.setTimer(0, 9, 50, 0);
    assert.equal(queue.nextDue(), 50);

    first.state = 'terminated';
    clock.at = 50;
    assert.equal(queue.nextDue(), null);
    assert.equal(queue.peek(ALL), null);
    assert.equal(queue.diagnostics().timers, 0);
});

test('only the procedure a timer was set with is that timer\'s', ()=>{
    const { queue } = threaded();
    queue.setTimer(0x40, 1, 50, 0x401000);
    queue.setTimer(0x40, 2, 50, 0);

    assert.equal(queue.isTimerProc(0x40, 1, 0x401000), true);
    assert.equal(queue.isTimerProc(0x40, 1, 0x402000), false);
    assert.equal(queue.isTimerProc(0x40, 2, 0), false, 'a timer with none has none');
    assert.equal(queue.isTimerProc(0x41, 1, 0x401000), false);
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

test('a pointer that keeps moving leaves one message, not a backlog', ()=>{
    // Windows keeps the position in the queue's state and builds a move from it
    // on demand, so however fast the hardware reports, one is ever waiting. A
    // browser reports motion at the display's rate and the guest pumps slower,
    // so queuing each one makes a backlog no program can drain -- it works
    // through positions the pointer left long ago and stops responding.
    const queue = createMessageQueue();

    for (let step = 0; step < 500; step++)
    {
        queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: step, x: step, y: step });
    }

    const taken = queue.peek(ALL);
    assert.equal(taken?.message, WM_MOUSEMOVE);
    assert.equal(taken?.lParam, 499, 'where the pointer is now, not where it started');
    assert.equal(taken?.x, 499);
    assert.equal(queue.peek(ALL), null,
        'and nothing behind it');
});

test('a move is coalesced per window, not across all of them', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: 1 });
    queue.post({ hwnd: 5, message: WM_MOUSEMOVE, wParam: 0, lParam: 2 });
    queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: 3 });

    const first = queue.peek(ALL);
    const second = queue.peek(ALL);
    assert.deepEqual([first?.hwnd, first?.lParam], [4, 3]);
    assert.deepEqual([second?.hwnd, second?.lParam], [5, 2]);
    assert.equal(queue.peek(ALL), null);
});

test('a coalesced move keeps its place in the order around it', ()=>{
    // Overtaking the messages before it would report a button as pressed
    // somewhere the pointer had already left.
    const queue = createMessageQueue();
    queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: 1 });
    queue.post({ hwnd: 4, message: 0x0201, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: WM_MOUSEMOVE, wParam: 0, lParam: 9 });

    const order = [];
    for (;;)
    {
        const next = queue.peek(ALL);
        if (!next)
        {
            break;
        }
        order.push([next.message, next.lParam]);
    }
    assert.deepEqual(order, [[WM_MOUSEMOVE, 9], [0x0201, 0]],
        'the move stays where it was, carrying the latest position');
});

test('the queue says when its next timer comes due', ()=>{
    // A caller on an empty queue waits for two things: something posted from
    // outside, which nobody can predict, and a timer of its own -- whose due
    // time is written down right here. Without asking, whoever drives the
    // machine has to keep looking to find out.
    const { clock, queue } = timed();
    assert.equal(queue.nextTimerDue(), null, 'no timers, nothing to wait for');

    clock.at = 100;
    queue.setTimer(0x40, 1, 250, 0);
    queue.setTimer(0x40, 2, 40, 0);
    assert.equal(queue.nextTimerDue(), 140, 'the soonest of them, in guest time');

    queue.killTimer(0x40, 2);
    assert.equal(queue.nextTimerDue(), 350);
    queue.killTimer(0x40, 1);
    assert.equal(queue.nextTimerDue(), null);
});

test('a message asked for later is made and posted once its time has come', ()=>{
    const { clock, queue } = timed();
    let made = 0;
    const make = ()=>{
        made++;
        return { hwnd: 0x40, message: WM_USER, wParam: clock.at, lParam: 0 };
    };
    queue.postLater('hover', 400, ()=>null);
    queue.postLater('hover', 50, make);
    assert.equal(queue.nextTimerDue(), 50, 'a second request replaces the first');
    clock.at = 49;
    assert.equal(queue.peek(ALL), null, 'not yet');
    assert.equal(made, 0, 'and not made before its time');
    clock.at = 60;
    assert.equal(queue.news() & QS_POSTMESSAGE, QS_POSTMESSAGE, 'a wait wakes for it');
    assert.deepEqual(queue.peek(ALL)?.wParam, 60, 'made when it came due, not when asked for');
    assert.equal(queue.nextTimerDue(), null);

    queue.postLater('hover', 10, make);
    assert.equal(queue.cancelLater('hover'), true);
    clock.at = 100;
    assert.equal(queue.peek(ALL), null, 'a cancelled one is never made');
    assert.equal(made, 1);
});

test('the queue says what a program pumps, not only how much', ()=>{
    // A count says how busy a loop is; which messages says what it is doing,
    // and a loop that spends a third of every frame waiting is waiting for one
    // particular thing. Without this the only way to find out is to read the
    // guest's own code.
    const { clock, queue } = timed();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 4, message: WM_KEYDOWN, wParam: 0x41, lParam: 0 });
    queue.setTimer(4, 1, 10, 0);

    queue.peek(ALL);
    queue.peek(ALL);
    queue.peek(ALL);
    clock.at = 100;
    queue.peek(ALL);

    const seen = queue.diagnostics();
    assert.equal(seen.byMessage[`0x${WM_USER.toString(16)}`], 2);
    assert.equal(seen.byMessage[`0x${WM_KEYDOWN.toString(16)}`], 1);
    assert.equal(seen.byMessage['0x113'], 1, 'a timer counts as the message it becomes');
    assert.equal(seen.timers, 1);
    assert.equal(seen.timerDue, 110, 'and when the next one is owed');
});

test('a peek that leaves the message alone does not count it as pumped', ()=>{
    const { queue } = timed();
    queue.post({ hwnd: 4, message: WM_USER, wParam: 0, lParam: 0 });
    queue.peek({ hwnd: null, first: 0, last: 0, remove: false });
    assert.deepEqual(queue.diagnostics().byMessage, {});
});

test('a timer says how late its ticks were delivered', ()=>{
    // A program that paces itself by a timer runs at the rate the timer is
    // actually delivered at, not the rate it asked for. Measured on a real
    // title, two fifths of every frame went into waiting for one of these, and
    // nothing in any report could say whether the wait was the program's own
    // choice or our lateness.
    let clock = 0;
    const queue = createMessageQueue({ now: ()=>clock });
    queue.setTimer(0x40, 7, 16, 0);

    clock = 16;
    assert.equal(queue.peek(ALL)?.message, WM_TIMER, 'on time');
    let report = queue.diagnostics();
    assert.equal(report.timerTicks, 1);
    assert.equal(report.timerLateTicks, 0, 'a tick taken the moment it came due is not late');

    // Nobody looked until well past the next tick.
    clock = 52;
    assert.equal(queue.peek(ALL)?.message, WM_TIMER);
    report = queue.diagnostics();
    assert.equal(report.timerTicks, 2);
    assert.equal(report.timerLateTicks, 1);
    assert.equal(report.worstTimerLateMs, 20, 'due at 32, taken at 52');
    assert.deepEqual(report.timerIntervals, [16], 'and what it asked for is reported too');
});

test('looking at a timer without taking it leaves the tick where it is', ()=>{
    // The pump written the ordinary way looks first and retrieves second. With
    // the look consuming the tick, the retrieve found an empty queue and the
    // program settled down to wait for something it had already been handed and
    // thrown away -- so a menu paced by a fifty-millisecond timer ran at a
    // fraction of twenty frames a second, and two fifths of every frame went
    // into waiting.
    let clock = 0;
    const queue = createMessageQueue({ now: ()=>clock });
    queue.setTimer(0x40, 7, 50, 0);
    clock = 50;

    const looked = queue.peek({ ...ALL, remove: false });
    assert.equal(looked?.message, WM_TIMER, 'the look sees the tick');
    assert.equal(queue.diagnostics().timerTicks, 0, 'and does not count as taking it');

    const taken = queue.peek(ALL);
    assert.equal(taken?.message, WM_TIMER, 'and the tick is still there to retrieve');
    assert.equal(queue.diagnostics().timerTicks, 1);

    // Taken, so the next one is a period away rather than immediately due.
    assert.equal(queue.peek(ALL), null);
    clock = 100;
    assert.equal(queue.peek(ALL)?.message, WM_TIMER);
});

test('the queue remembers the last message it handed out, and only those it removed', ()=>{
    const queue = createMessageQueue();
    assert.equal(queue.last(), null);
    queue.post({ hwnd: 0x40, message: 0x400, wParam: 1, lParam: 2, time: 0x1234 });
    queue.post({ hwnd: 0x40, message: 0x401, wParam: 3, lParam: 4 });

    queue.peek({ ...ALL, remove: false });
    assert.equal(queue.last(), null, 'a look is not a take');
    const first = queue.peek({ ...ALL, remove: true });
    assert.equal(queue.last(), first);
    assert.equal(queue.last()?.time, 0x1234);
    queue.peek({ ...ALL, remove: true });
    assert.equal(queue.last()?.message, 0x401);
});

test('the queue says what is waiting by class, as GetQueueStatus reports it', ()=>{
    const queue = createMessageQueue();
    assert.deepEqual(queue.status(), { inQueue: 0, changed: 0 },
        'an empty queue has nothing waiting and no news');

    queue.post({ hwnd: 0x40, message: WM_KEYDOWN, wParam: 0x41, lParam: 0 });
    queue.post({ hwnd: 0x40, message: WM_LBUTTONDOWN, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 0x40, message: WM_MOUSEMOVE, wParam: 0, lParam: 0 });
    queue.post({ hwnd: 0, message: WM_USER, wParam: 0, lParam: 0 });

    const status = queue.status();
    // A film-skip loop asks for the input classes alone: the press it is waiting
    // for has to be in there, and it has to be there as input rather than as a
    // post, or the loop masks it away and plays the film to the end.
    assert.equal(status.inQueue & QS_KEY, QS_KEY);
    assert.equal(status.inQueue & QS_MOUSEBUTTON, QS_MOUSEBUTTON);
    assert.equal(status.inQueue & QS_MOUSEMOVE, QS_MOUSEMOVE);
    assert.equal(status.inQueue & QS_POSTMESSAGE, QS_POSTMESSAGE);
    assert.equal(status.changed & QS_KEY, QS_KEY, 'and all of it is news the first time');
});

test('news is what arrived since the last look, and only what is still there', ()=>{
    const queue = createMessageQueue();
    queue.post({ hwnd: 0x40, message: WM_KEYDOWN, wParam: 0x41, lParam: 0 });

    assert.equal(queue.status().changed & QS_KEY, QS_KEY);
    assert.equal(queue.status().changed, 0, 'asking twice does not report it twice');
    assert.equal(queue.status().inQueue & QS_KEY, QS_KEY, 'though it is still waiting');

    queue.post({ hwnd: 0x40, message: WM_LBUTTONDOWN, wParam: 0, lParam: 0 });
    queue.peek(ALL);
    assert.equal(queue.status().changed, 0,
        'a retrieval counts as a look and clears the news with it');

    queue.post({ hwnd: 0x40, message: WM_KEYDOWN, wParam: 0x42, lParam: 0 });
    queue.peek({ hwnd: ANY_WINDOW, first: WM_KEYDOWN, last: WM_KEYDOWN, remove: true });
    assert.equal(queue.status().changed & QS_KEY, 0,
        'and a keystroke already taken is no longer waiting to be news about');
});

test('a paint and a due timer are waiting even though neither is a queued message', ()=>{
    let clock = 0;
    const queue = createMessageQueue({ now: ()=>clock });
    let dirty = 0x40;
    queue.paintsFrom(()=>dirty);
    queue.setTimer(0x40, 7, 50, 0);

    const first = queue.status();
    assert.equal(first.inQueue & QS_PAINT, QS_PAINT);
    assert.equal(first.changed & QS_PAINT, QS_PAINT, 'a window that was clean is news');
    assert.equal(first.inQueue & QS_TIMER, 0, 'the timer is not due yet');

    assert.equal(queue.status().changed & QS_PAINT, 0,
        'a window still dirty is not news again -- otherwise every frame reports it');

    clock = 50;
    const due = queue.status();
    assert.equal(due.inQueue & QS_TIMER, QS_TIMER);
    assert.equal(due.changed & QS_TIMER, QS_TIMER);

    dirty = 0;
    assert.equal(queue.status().inQueue & QS_PAINT, 0, 'a painted window stops waiting');
});

test('a pending quit is something waiting, so a loop watching the queue wakes for it', ()=>{
    const queue = createMessageQueue();
    queue.postQuit(0);

    const status = queue.status();
    assert.equal(status.inQueue & QS_POSTMESSAGE, QS_POSTMESSAGE);
    assert.equal(status.changed & QS_POSTMESSAGE, QS_POSTMESSAGE);
});

// --- hot keys ---

test('a hot key is the window-and-id pair, which replaces itself and nothing else', ()=>{
    const queue = createMessageQueue();
    assert.equal(queue.registerHotKey(0x40, 1, 0x0001, 0x09), true, 'Alt+Tab');
    // The same pair with a new combination replaces it rather than colliding
    // with its own earlier claim.
    assert.equal(queue.registerHotKey(0x40, 1, 0x0002, 0x2b), true, 'Ctrl+plus');
    // A combination already taken is refused however the pair differs...
    assert.equal(queue.registerHotKey(0x44, 1, 0x0002, 0x2b), false, 'another window');
    assert.equal(queue.registerHotKey(0x40, 2, 0x0002, 0x2b), false, 'another id');
    // ...and MOD_NOREPEAT is a rule about repeats, not part of the combination,
    // so a registration differing only in it collides all the same.
    assert.equal(queue.registerHotKey(0x44, 2, 0x4002, 0x2b), false);

    assert.equal(queue.unregisterHotKey(0x40, 9), false, 'an unknown id is no registration');
    assert.equal(queue.unregisterHotKey(0x40, 1), true);
    assert.equal(queue.registerHotKey(0x44, 1, 0x0002, 0x2b), true, 'the freed combination fits');
});

test('a destroyed window takes its hot keys with it, and only its own', ()=>{
    const queue = createMessageQueue();
    queue.registerHotKey(0x40, 1, 0, 0x41);
    queue.registerHotKey(0x44, 1, 0, 0x42);
    queue.unregisterHotKeysFor(0x40);

    assert.equal(queue.unregisterHotKey(0x40, 1), false, 'gone with the window');
    assert.equal(queue.unregisterHotKey(0x44, 1), true, 'the neighbour kept its claim');
});

test('a claimed keystroke leaves the queue as WM_HOTKEY, with the id and the combination', ()=>{
    const WM_HOTKEY = 0x0312;
    const queue = createMessageQueue({ now: ()=>77 });
    queue.registerHotKey(0x40, 3, 0x0001, 0x41);

    // The held-Alt state arrives through the thunk the host hands down.
    const alt = createMessageQueue({ now: ()=>77, keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    alt.registerHotKey(0x40, 3, 0x0001, 0x41);
    alt.post({ hwnd: 0, message: WM_KEYDOWN, wParam: 0x41, lParam: 1, x: 0, y: 0, time: 5 });
    assert.deepEqual(alt.peek(ALL), {
        hwnd: 0x40, message: WM_HOTKEY, wParam: 3,
        lParam: 0x41 << 16 | 0x0001, time: 77, x: 0, y: 0,
    });

    // With nothing held, the registration does not fit and the key stands.
    queue.post({ hwnd: 0x99, message: WM_KEYDOWN, wParam: 0x41, lParam: 1, x: 0, y: 0 });
    assert.equal(queue.peek(ALL)?.message, WM_KEYDOWN);
});
