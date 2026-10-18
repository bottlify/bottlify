/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createInputDevice, KEYBOARD, MOUSE, KEYBOARD_KEYS, KEY_DOWN, DIMOUSE_OFS,
} from './devices.js';

/** DIK_A and DIK_S, which is as much of the table as any of this needs. */
const DIK_A = 0x1e;
const DIK_S = 0x1f;

function clock(){
    let ms = 5000;
    return { now: ()=>ms, advance: (/** @type {number} */ by)=>{
        ms += by;
    } };
}

/** @param {'keyboard' | 'mouse'} kind */
function device(kind){
    const time = clock();
    const it = createInputDevice({ kind, now: time.now });
    it.acquire();
    return { it, time };
}

test('an unacquired device takes no events at all', ()=>{
    const it = createInputDevice({ kind: KEYBOARD, now: ()=>0 });
    assert.equal(it.acquired, false);
    assert.equal(it.post({ kind: 'key', code: DIK_A, down: true }), false);
    assert.equal(it.keyboardState()[DIK_A], 0);
});

test('a key down sets its byte\'s high bit, and up clears it', ()=>{
    const { it } = device(KEYBOARD);
    it.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(it.keyboardState()[DIK_A], KEY_DOWN);
    it.post({ kind: 'key', code: DIK_A, down: false });
    assert.equal(it.keyboardState()[DIK_A], 0);
});

test('the state handed out is a copy, not the array that keeps changing', ()=>{
    const { it } = device(KEYBOARD);
    it.post({ kind: 'key', code: DIK_A, down: true });
    const snapshot = it.keyboardState();
    it.post({ kind: 'key', code: DIK_A, down: false });
    assert.equal(snapshot[DIK_A], KEY_DOWN, 'or every reader shares one mutable array');
    assert.equal(snapshot.length, KEYBOARD_KEYS);
});

test('mouse axes are deltas and are cleared by reading them', ()=>{
    const { it } = device(MOUSE);
    it.post({ kind: 'mouseMove', x: 5, y: -3 });
    it.post({ kind: 'mouseMove', x: 2, y: 1 });
    assert.deepEqual(
        (({ x, y })=>({ x, y }))(it.mouseState()), { x: 7, y: -2 },
        'movement between reads accumulates');
    const next = it.mouseState();
    assert.equal(next.x, 0, 'not clearing them makes the view spin for ever');
    assert.equal(next.y, 0);
});

test('mouse buttons are levels and survive a read', ()=>{
    const { it } = device(MOUSE);
    it.post({ kind: 'mouseButton', code: 0, down: true });
    assert.equal(it.mouseState().buttons[0], KEY_DOWN);
    assert.equal(it.mouseState().buttons[0], KEY_DOWN, 'a held button stays held');
    it.post({ kind: 'mouseButton', code: 0, down: false });
    assert.equal(it.mouseState().buttons[0], 0);
});

test('an unbuffered device records no events, however many arrive', ()=>{
    const { it } = device(KEYBOARD);
    assert.equal(it.bufferSize, 0);
    it.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(it.queued, 0);
    assert.deepEqual(it.drain(10).events, []);
});

test('a buffered device queues one event per state change', ()=>{
    const { it, time } = device(KEYBOARD);
    it.setBufferSize(32);
    it.post({ kind: 'key', code: DIK_A, down: true });
    time.advance(10);
    it.post({ kind: 'key', code: DIK_S, down: true });

    const { events, overflow } = it.drain(10);
    assert.equal(overflow, false);
    assert.deepEqual(events.map(e=>[e.offset, e.data]),
        [[DIK_A, KEY_DOWN], [DIK_S, KEY_DOWN]]);
    assert.ok(events[1].time > events[0].time, 'timestamped from the guest\'s clock');
    assert.deepEqual(events.map(e=>e.sequence), [0, 1]);
});

test('a key repeat is not a state change and is not queued', ()=>{
    const { it } = device(KEYBOARD);
    it.setBufferSize(32);
    it.post({ kind: 'key', code: DIK_A, down: true });
    it.post({ kind: 'key', code: DIK_A, down: true });
    it.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(it.queued, 1, 'a held key would otherwise fill the ring');
});

test('draining consumes; peeking does not', ()=>{
    const { it } = device(KEYBOARD);
    it.setBufferSize(32);
    it.post({ kind: 'key', code: DIK_A, down: true });
    assert.equal(it.drain(10, true).events.length, 1);
    assert.equal(it.queued, 1, 'a peek leaves it where it was');
    assert.equal(it.drain(10).events.length, 1);
    assert.equal(it.queued, 0);
});

test('draining part of the queue leaves the rest, oldest first', ()=>{
    const { it } = device(KEYBOARD);
    it.setBufferSize(32);
    for (const code of [1, 2, 3, 4])
    {
        it.post({ kind: 'key', code, down: true });
    }
    assert.deepEqual(it.drain(2).events.map(e=>e.offset), [1, 2]);
    assert.deepEqual(it.drain(9).events.map(e=>e.offset), [3, 4]);
});

test('overflow drops the oldest and is reported once', ()=>{
    const { it } = device(KEYBOARD);
    it.setBufferSize(3);
    for (const code of [1, 2, 3, 4])
    {
        it.post({ kind: 'key', code, down: true });
    }
    const first = it.drain(10);
    assert.equal(first.overflow, true);
    assert.deepEqual(first.events.map(e=>e.offset), [3, 4],
        'the newest survive, or an overflow looks like the player stopped');
    assert.equal(it.drain(10).overflow, false,
        'reported twice, a program resynchronises for ever');
});

test('a buffer of N holds N - 1 events', ()=>{
    // joystick8.c's buffered reads, in miniature. A buffer of one holds
    // nothing: a change overflows it, a peek reports that and 0 events, and
    // the read after the peek is DI_OK -- the peek took the report.
    const one = device(KEYBOARD).it;
    one.setBufferSize(1);
    one.post({ kind: 'key', code: DIK_A, down: true });
    assert.deepEqual(one.drain(1, true), { events: [], overflow: true });
    assert.deepEqual(one.drain(1), { events: [], overflow: false });

    // A buffer of ten: five changes, one peeked and four read, leave one;
    // nine more make ten waiting for nine places, and the one that goes is
    // the one left over from before.
    const { it } = device(KEYBOARD);
    it.setBufferSize(10);
    /** @param {number[]} codes */
    const press = codes=>codes.forEach(code=>it.post({ kind: 'key', code, down: true }));
    press([1, 2, 3, 4, 5]);
    assert.deepEqual(it.drain(1, true).events.map(e=>e.offset), [1]);
    assert.deepEqual(it.drain(4).events.map(e=>e.offset), [1, 2, 3, 4]);
    press([11, 12, 13, 14, 15]);
    press([21, 22, 23, 24]);
    const next = it.drain(1);
    assert.equal(next.overflow, true);
    assert.deepEqual(next.events.map(e=>e.offset), [11]);
    const rest = it.drain(10);
    assert.equal(rest.overflow, false);
    assert.deepEqual(rest.events.map(e=>e.offset), [12, 13, 14, 15, 21, 22, 23, 24]);
});

test('setting a buffer size clears whatever was queued under the old one', ()=>{
    const { it } = device(KEYBOARD);
    it.setBufferSize(32);
    it.post({ kind: 'key', code: DIK_A, down: true });
    it.setBufferSize(8);
    assert.equal(it.queued, 0);
});

test('unacquiring keeps the buffer and throws away the pending motion', ()=>{
    // device8.c test_sys_mouse: events buffered before Unacquire are still
    // there after it, and an overflow is still reported; what arrives while
    // nobody holds the device is never buffered at all.
    const { it } = device(MOUSE);
    it.setBufferSize(3);
    it.post({ kind: 'mouseMove', x: 40, y: 40 });
    it.post({ kind: 'mouseMove', x: 1, y: 0 });
    it.unacquire();
    assert.equal(it.post({ kind: 'mouseMove', x: 5, y: 5 }), false);
    assert.equal(it.queued, 2);
    it.acquire();
    const state = it.mouseState();
    assert.equal(state.x, 0, 'a program taking the device back reads it fresh');
    assert.equal(state.y, 0);
    const kept = it.drain(10);
    assert.equal(kept.overflow, true, 'three events for two places, reported after it');
    assert.deepEqual(kept.events.map(e=>[e.offset, e.data]),
        [[DIMOUSE_OFS.Y, 40], [DIMOUSE_OFS.X, 1]]);
});

test('a mouse event is queued at the offset of the axis it moved', ()=>{
    const { it } = device(MOUSE);
    it.setBufferSize(32);
    it.post({ kind: 'mouseMove', x: 3, y: 0 });
    it.post({ kind: 'mouseWheel', wheel: 120 });
    it.post({ kind: 'mouseButton', code: 1, down: true });
    assert.deepEqual(it.drain(10).events.map(e=>[e.offset, e.data]), [
        [DIMOUSE_OFS.X, 3],
        [DIMOUSE_OFS.Z, 120],
        [DIMOUSE_OFS.BUTTON0 + 1, KEY_DOWN],
    ]);
});

test('a zero-length move queues nothing', ()=>{
    const { it } = device(MOUSE);
    it.setBufferSize(32);
    it.post({ kind: 'mouseMove', x: 0, y: 0 });
    assert.equal(it.queued, 0);
});

test('the notification handle is remembered as given', ()=>{
    const { it } = device(KEYBOARD);
    assert.equal(it.notifyEvent, 0);
    it.setNotification(0x1234);
    assert.equal(it.notifyEvent, 0x1234);
});

test('references are counted and never go below zero', ()=>{
    const { it } = device(KEYBOARD);
    assert.equal(it.addRef(), 2);
    assert.equal(it.release(), 1);
    assert.equal(it.release(), 0);
    assert.equal(it.release(), 0);
});

test('a mouse in absolute mode reports where it is, from the cursor it was taken at', ()=>{
    // DIPROPAXISMODE_ABS: a program that asked for positions and was handed the
    // motion read a mouse that never left where it started.
    const time = clock();
    const it = createInputDevice({ kind: MOUSE, now: time.now, cursor: ()=>({ x: 320, y: 240 }) });
    it.setAbsolute(true);
    it.setBufferSize(8);
    it.acquire();
    it.post({ kind: 'mouseMove', x: 10, y: -5 });
    const where = (/** @type {{ x: number, y: number }} */ { x, y })=>({ x, y });
    assert.deepEqual(where(it.mouseState()), { x: 330, y: 235 });
    assert.deepEqual(where(it.mouseState()), { x: 330, y: 235 }, 'reading leaves it where it is');
    it.post({ kind: 'mouseMove', x: 1, y: 0 });
    assert.deepEqual(where(it.mouseState()), { x: 331, y: 235 });
    assert.deepEqual(it.drain(8).events.map(event=>event.data), [330, 235, 331],
        'a buffered event carries the position too');
});
