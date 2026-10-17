/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowManager } from './manager.js';

const WS_EX_TOPMOST = 0x8;

/**
 * A window's state as a process tells it.
 *
 * @param {number} hwnd @param {Partial<import('./manager.js').WindowState>} [fields]
 * @returns {import('./manager.js').WindowState}
 */
const state = (hwnd, fields = {})=>({
    hwnd, processId: 0x100, threadId: 0x104, parent: 0, owner: 0, className: 'Test',
    title: `window ${hwnd}`, style: 0x10000000, exStyle: 0,
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
    client: { left: 0, top: 0, right: 100, bottom: 100 },
    visible: true, enabled: true, minimized: false, maximized: false, topmost: false, region: null,
    ...fields,
});

/** @param {ReturnType<typeof createWindowManager>} manager */
const order = manager=>manager.topLevel().map(each=>each.hwnd);

test('a window told of is kept as it was told, and a new one comes in on top', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1));
    manager.publish(state(2, { processId: 0x200 }));
    assert.deepEqual(order(manager), [2, 1], 'the topmost first');
    assert.equal(manager.get(2)?.processId, 0x200);
    assert.ok(Object.isFrozen(manager.get(1)) && Object.isFrozen(manager.get(1)?.rect),
        'a state is not changed by whoever reads it');
    manager.publish(state(1, { title: 'renamed' }));
    assert.equal(manager.get(1)?.title, 'renamed');
    assert.deepEqual(order(manager), [2, 1], 'a change is not a raise');
});

test('raised, lowered and put after another, a window moves in its band only', ()=>{
    const manager = createWindowManager();
    for (const hwnd of [1, 2, 3])
    {
        manager.publish(state(hwnd));
    }
    manager.publish(state(9, { exStyle: WS_EX_TOPMOST, topmost: true }));
    assert.deepEqual(order(manager), [9, 3, 2, 1]);
    manager.raise(1);
    assert.deepEqual(order(manager), [9, 1, 3, 2], 'not above the topmost band');
    manager.lower(3);
    assert.deepEqual(order(manager), [9, 1, 2, 3]);
    manager.insertAfter(3, 1);
    assert.deepEqual(order(manager), [9, 1, 3, 2], 'just below the one named');
    manager.lower(9);
    assert.deepEqual(order(manager), [9, 1, 3, 2], 'a topmost window stays above the rest');
    manager.publish(state(2, { topmost: true }));
    assert.deepEqual(order(manager), [9, 2, 1, 3], 'made topmost, it goes into that band');
    manager.raise(2);
    assert.deepEqual(order(manager), [2, 9, 1, 3], 'and to its top when raised');
});

test('an owned window stays above its owner, and goes up with it', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1));
    manager.publish(state(2, { owner: 1 }));
    manager.publish(state(3));
    assert.deepEqual(order(manager), [3, 2, 1]);
    manager.raise(1);
    assert.deepEqual(order(manager), [2, 1, 3], 'the owner raised, what it owns above it');
    manager.lower(2);
    assert.deepEqual(order(manager), [2, 1, 3], 'lowered, it stops just above its owner');
    manager.raise(3);
    manager.raise(2);
    assert.deepEqual(order(manager), [2, 3, 1],
        'raised alone, as SetWindowPos raises it: its owner stays where it was');
});

test('a window owned by a topmost one is above it, in the topmost band with it', ()=>{
    // Half-Life's menu is a topmost dialog, and its difficulty dialog, owned
    // by it and not topmost itself, was kept in the band beneath it: the menu
    // went on drawing over the dialog the program waited on.
    const manager = createWindowManager();
    manager.publish(state(1));
    manager.publish(state(2, { exStyle: WS_EX_TOPMOST, topmost: true }));
    manager.publish(state(3, { owner: 2 }));
    assert.deepEqual(order(manager), [3, 2, 1], 'over its owner, the plain window beneath both');
    manager.raise(1);
    assert.deepEqual(order(manager), [3, 2, 1], 'and above a plain window raised after it');
    manager.publish(state(4, { owner: 3 }));
    assert.deepEqual(order(manager), [4, 3, 2, 1], 'owned at one more remove, the same band');
});

test('a child is not in the order of top-level windows, and the deepest one under a point is'
    + ' found', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1, { rect: { left: 0, top: 0, right: 200, bottom: 200 } }));
    manager.publish(state(2, { parent: 1, rect: { left: 10, top: 10, right: 50, bottom: 50 } }));
    manager.publish(state(3, { parent: 2, rect: { left: 20, top: 20, right: 30, bottom: 30 } }));
    manager.publish(state(4, { rect: { left: 150, top: 150, right: 300, bottom: 300 } }));
    assert.deepEqual(order(manager), [4, 1]);
    assert.deepEqual(manager.children(1).map(each=>each.hwnd), [2]);
    assert.equal(manager.fromPoint(25, 25), 3);
    assert.equal(manager.fromPoint(40, 40), 2);
    assert.equal(manager.fromPoint(100, 100), 1);
    assert.equal(manager.fromPoint(160, 160), 4, 'the window on top');
    assert.equal(manager.fromPoint(400, 400), 0);
    manager.publish(state(4, { visible: false, rect: { left: 150, top: 150, right: 300,
        bottom: 300 } }));
    assert.equal(manager.fromPoint(160, 160), 1, 'a hidden window is not hit');
});

test('foreground and capture follow the window, and go with it', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1));
    manager.publish(state(2, { parent: 1 }));
    manager.setForeground(2);
    assert.equal(manager.foreground(), 1, 'the foreground window is a top-level one');
    manager.setCapture(2);
    assert.equal(manager.capture(), 2);
    manager.remove(2);
    assert.equal(manager.capture(), 0);
    manager.remove(1);
    assert.equal(manager.foreground(), 0);
    manager.setCapture(7);
    assert.equal(manager.capture(), 0, 'no window, no capture');
});

test('a process gone takes its windows with it', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1));
    manager.publish(state(2, { processId: 0x200 }));
    manager.publish(state(3, { processId: 0x200, parent: 2 }));
    manager.removeProcess(0x200);
    assert.deepEqual(order(manager), [1]);
    assert.equal(manager.get(3), null);
});

test('a subscriber hears every change in order, each with its revision, and nothing that is no'
    + ' change', ()=>{
    const manager = createWindowManager();
    /** @type {string[]} */
    const heard = [];
    const stop = manager.subscribe(event=>heard.push(`${event.kind} ${event.hwnd} r${
        event.revision}${event.state ? '' : ' gone'}`));
    manager.publish(state(1));
    manager.publish(state(1));
    manager.publish(state(2));
    manager.raise(2);
    manager.raise(1);
    manager.setForeground(1);
    manager.remove(2);
    stop();
    manager.remove(1);
    assert.deepEqual(heard, ['created 1 r1', 'created 2 r2', 'stacked 1 r3', 'foreground 1 r4',
        'removed 2 r5 gone']);
    assert.equal(manager.revision(), 6, 'the change after stopping still counts');
});

test('the page\'s input goes to the process of the window that should have it', ()=>{
    const manager = createWindowManager();
    manager.publish(state(1, { processId: 0x100, rect: { left: 0, top: 0, right: 200,
        bottom: 200 } }));
    manager.publish(state(2, { processId: 0x200, rect: { left: 100, top: 100, right: 300,
        bottom: 300 } }));
    manager.publish(state(3, { processId: 0x300, parent: 1, rect: { left: 10, top: 10,
        right: 50, bottom: 50 } }));
    manager.setForeground(1);
    manager.raise(2);
    assert.equal(manager.inputTarget({ kind: 'pointerMove', x: 150, y: 150 }), 0x200,
        'the window on top under the pointer');
    assert.equal(manager.inputTarget({ kind: 'pointerButton' }), 0x200,
        'a button where the pointer last was');
    assert.equal(manager.inputTarget({ kind: 'pointerMove', x: 20, y: 20 }), 0x300,
        'the deepest child there, whoever made it');
    assert.equal(manager.inputTarget({ kind: 'key' }), 0x100, 'the keyboard: the foreground');
    manager.setCapture(2);
    assert.equal(manager.inputTarget({ kind: 'pointerMove', x: 20, y: 20 }), 0x200,
        'the window holding the mouse, wherever the pointer is');
    manager.releaseCapture();
    assert.equal(manager.inputTarget({ kind: 'wheel', x: 400, y: 400 }), null,
        'the desktop under the pointer: no program');
    manager.setFocus(3);
    assert.equal(manager.inputTarget({ kind: 'key' }), 0x300, 'the keyboard: the focus');
    manager.setForeground(0);
    assert.equal(manager.inputTarget({ kind: 'key' }), null, 'no window in the foreground');
});

test('one focus for the run: the window that takes it comes up, and every other has lost it',
    ()=>{
        const manager = createWindowManager();
        for (const hwnd of [1, 2, 3, 4, 5])
        {
            manager.publish(state(hwnd, { processId: 0x100 * hwnd }));
        }
        manager.publish(state(6, { processId: 0x200, parent: 2 }));
        assert.deepEqual(order(manager), [5, 4, 3, 2, 1]);
        /** @type {string[]} */
        const heard = [];
        manager.subscribe(event=>heard.push(`${event.kind} ${event.hwnd}`));
        manager.setFocus(6);
        assert.deepEqual(order(manager), [2, 5, 4, 3, 1],
            'the second of five, the last now: on top of the rest');
        assert.equal(manager.focus(), 6, 'the focus is the control inside it');
        assert.equal(manager.foreground(), 2, 'its top-level window, the foreground one');
        assert.deepEqual(heard, ['stacked 2', 'foreground 2', 'focus 6']);
        manager.setFocus(4);
        assert.equal(manager.focus(), 4, 'taken by another, it is that one\'s only');
        assert.deepEqual(order(manager), [4, 2, 5, 3, 1]);
        manager.setForeground(5);
        assert.equal(manager.focus(), 0,
            'another window made the foreground one: the focus is no window\'s until placed');
        manager.setFocus(5);
        manager.remove(5);
        assert.deepEqual([manager.focus(), manager.foreground()], [0, 0],
            'gone with the window');
    });

test('the report keeps the top-level windows made, by whom, after they are gone', ()=>{
    // A window that comes and goes between two looks at the windows standing
    // was missed by a look on a timer; the report says it was made.
    const manager = createWindowManager();
    manager.publish(state(1, { className: 'Host' }));
    manager.publish(state(2, { processId: 0x200, className: 'Guest' }));
    manager.publish(state(3, { parent: 2, className: 'Child' }));
    manager.publish(state(2, { processId: 0x200, className: 'Guest', title: 'renamed' }));
    manager.remove(2);
    assert.deepEqual(manager.diagnostics().made, [
        { hwnd: '0x1', process: 0x100, className: 'Host' },
        { hwnd: '0x2', process: 0x200, className: 'Guest' },
    ], 'each once, a child and a change not among them, the one gone still there');
    for (let hwnd = 10; hwnd < 50; hwnd++)
    {
        manager.publish(state(hwnd));
    }
    const made = manager.diagnostics().made;
    assert.equal(made.length, 32, 'the last ones only');
    assert.equal(made.at(-1)?.hwnd, '0x31');
});
