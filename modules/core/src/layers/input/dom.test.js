/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDomInput } from './dom.js';

/**
 * A canvas, as far as this adapter is concerned.
 *
 * The adapter is the one piece of this layer a browser could disagree with, and
 * a stand-in cannot settle that -- what it does settle is everything the
 * adapter decides for itself: which keys it takes away from the page, what it
 * makes of a key press, where a click is in the game's own pixels, and that it
 * leaves nothing attached behind.
 *
 * @param {{ width?: number, height?: number,
 *           rect?: { left: number, top: number, width: number, height: number } }} [options]
 */
function fakeCanvas({ width = 640, height = 480, rect } = {}){
    /** @type {Map<string, ((event: any) => void)[]>} */
    const handlers = new Map();
    const attributes = new Set();
    const canvas = {
        width,
        height,
        tabIndex: -1,
        style: { outline: '' },
        focused: 0,
        blurred: 0,
        locks: 0,
        captured: /** @type {number[]} */ ([]),
        /** @param {string} name */
        hasAttribute: (/** @type {string} */ name)=>attributes.has(name),
        /** @param {string} type @param {(event: any) => void} handler */
        addEventListener(type, handler){
            handlers.set(type, [...handlers.get(type) ?? [], handler]);
        },
        /** @param {string} type @param {(event: any) => void} handler */
        removeEventListener(type, handler){
            handlers.set(type, (handlers.get(type) ?? []).filter(entry=>entry !== handler));
        },
        getBoundingClientRect: ()=>rect ?? { left: 0, top: 0, width, height },
        focus(){
            canvas.focused++;
            canvas.fire('focus', {});
        },
        blur(){
            canvas.blurred++;
            canvas.fire('blur', {});
        },
        /** @param {number} id */
        setPointerCapture(id){
            canvas.captured.push(id);
        },
        releasePointerCapture(){},
        requestPointerLock(){
            canvas.locks++;
        },
        /** @param {string} type @param {any} event */
        fire(type, event){
            const full = { preventDefault(){
                full.prevented = true;
            }, prevented: false, timeStamp: 0, ...event };
            for (const handler of handlers.get(type) ?? [])
            {
                handler(full);
            }
            return full;
        },
        listenerCount: ()=>[...handlers.values()].reduce((total, list)=>total + list.length, 0),
    };
    return canvas;
}

function harness(/** @type {any} */ options = {}){
    const canvas = fakeCanvas(options.canvas);
    /** @type {any[]} */
    const events = [];
    const adapter = createDomInput({
        canvas: /** @type {any} */ (canvas),
        send: event=>events.push(event),
        pointerLock: options.pointerLock ?? false,
    });
    return {
        canvas,
        adapter,
        events,
        drain(){
            const taken = [...events];
            events.length = 0;
            return taken;
        },
    };
}

test('the canvas is made focusable, since a canvas is not by default', ()=>{
    const h = harness();
    assert.equal(h.canvas.tabIndex, 0);
});

test('focus is shown while it is held, and given up with it', ()=>{
    const h = harness();
    h.canvas.fire('focus', {});
    assert.notEqual(h.canvas.style.outline, '');
    assert.deepEqual(h.drain(), [{ kind: 'focus', gained: true }]);

    h.canvas.fire('blur', {});
    assert.equal(h.canvas.style.outline, '');
    assert.deepEqual(h.drain(), [{ kind: 'focus', gained: false }]);
});

test('a key press is both a key and the character the browser composed', ()=>{
    const h = harness();
    const event = h.canvas.fire('keydown', { code: 'KeyA', key: 'a' });
    assert.equal(event.prevented, true, 'the guest consumes it');
    assert.deepEqual(h.drain(), [
        { kind: 'key', code: 'KeyA', down: true },
        { kind: 'text', text: 'a' },
    ]);
});

test('a named key with no character produces no text', ()=>{
    const h = harness();
    h.canvas.fire('keydown', { code: 'ArrowUp', key: 'ArrowUp' });
    assert.deepEqual(h.drain(), [{ kind: 'key', code: 'ArrowUp', down: true }]);
});

test('the keys with a character but no single-character name still make one', ()=>{
    const h = harness();
    h.canvas.fire('keydown', { code: 'Enter', key: 'Enter' });
    assert.deepEqual(h.drain()[1], { kind: 'text', text: '\r' });
});

test('a browser combination is left to the browser', ()=>{
    const h = harness();
    const event = h.canvas.fire('keydown', { code: 'KeyT', key: 't', ctrlKey: true });
    assert.equal(event.prevented, false, 'ctrl-t belongs to the person, not the guest');
    assert.deepEqual(h.drain(), [{ kind: 'key', code: 'KeyT', down: true }],
        'the key still reaches the guest, without a character');
});

test('reload and fullscreen are never taken away, and still reach the guest', ()=>{
    const h = harness();
    for (const code of ['F5', 'F11', 'F12', 'Escape'])
    {
        const event = h.canvas.fire('keydown', { code, key: code });
        assert.equal(event.prevented, false, `${code} is the browser's`);
    }
    assert.deepEqual(h.drain().filter(entry=>entry.kind === 'key').map(entry=>entry.code),
        ['F5', 'F11', 'F12', 'Escape']);
});

test('two Escapes in quick succession hand focus back to the page', ()=>{
    const h = harness();
    h.canvas.fire('focus', {});
    h.canvas.fire('keydown', { code: 'Escape', key: 'Escape', timeStamp: 1000 });
    assert.equal(h.canvas.blurred, 0, 'one Escape is the guest\'s menu key');

    h.canvas.fire('keydown', { code: 'Escape', key: 'Escape', timeStamp: 1200 });
    assert.equal(h.canvas.blurred, 1);
    assert.deepEqual(h.drain().at(-1), { kind: 'focus', gained: false },
        'and letting go releases what was held');
});

test('two Escapes far apart are just two Escapes', ()=>{
    const h = harness();
    h.canvas.fire('keydown', { code: 'Escape', key: 'Escape', timeStamp: 1000 });
    h.canvas.fire('keydown', { code: 'Escape', key: 'Escape', timeStamp: 3000 });
    assert.equal(h.canvas.blurred, 0);
});

test('a pointer is reported in the game\'s pixels, not the page\'s', ()=>{
    // A canvas of 640x480 drawn twice that size: a click in the middle of the
    // box is the middle of the game, not a coordinate off the end of it.
    const h = harness({ canvas: {
        width: 640, height: 480, rect: { left: 100, top: 50, width: 1280, height: 960 },
    } });
    h.canvas.fire('focus', {});
    h.drain();
    h.canvas.fire('pointermove', { clientX: 740, clientY: 530, movementX: 2, movementY: 0 });
    assert.deepEqual(h.drain(), [{ kind: 'pointerMove', x: 320, y: 240, dx: 1, dy: 0 }]);
});

test('motion too small to count is kept rather than dropped', ()=>{
    const h = harness({ canvas: {
        width: 640, height: 480, rect: { left: 0, top: 0, width: 1280, height: 960 },
    } });
    h.canvas.fire('focus', {});
    h.drain();
    h.canvas.fire('pointermove', { clientX: 0, clientY: 0, movementX: 1, movementY: 0 });
    assert.equal(h.drain()[0].dx, 0, 'half a game pixel is not a pixel yet');
    h.canvas.fire('pointermove', { clientX: 0, clientY: 0, movementX: 1, movementY: 0 });
    assert.equal(h.drain()[0].dx, 1, 'and the other half arrives');
});

test('a button takes focus, captures the pointer and is named', ()=>{
    const h = harness();
    const event = h.canvas.fire('pointerdown', { button: 2, pointerId: 7 });
    assert.equal(event.prevented, true);
    assert.equal(h.canvas.focused, 1, 'clicking in is the gesture that means "playing now"');
    assert.deepEqual(h.canvas.captured, [7], 'so the release lands here even off the canvas');
    assert.equal(h.drain().at(-1).button, 'right');

    h.canvas.fire('pointerup', { button: 2, pointerId: 7 });
    assert.deepEqual(h.drain(), [{ kind: 'pointerButton', button: 'right', down: false }]);
});

test('the pointer is only locked when the caller asked for that', ()=>{
    const plain = harness();
    plain.canvas.fire('pointerdown', { button: 0, pointerId: 1 });
    assert.equal(plain.canvas.locks, 0, 'never on its own');

    const locking = harness({ pointerLock: true });
    locking.canvas.fire('pointerdown', { button: 0, pointerId: 1 });
    assert.equal(locking.canvas.locks, 1, 'and only from inside the gesture');
});

test('nothing is captured from a canvas nobody is playing', ()=>{
    const h = harness();
    const scroll = h.canvas.fire('wheel', { deltaY: 400, deltaMode: 0 });
    h.canvas.fire('pointermove', { clientX: 10, clientY: 10, movementX: 4, movementY: 4 });
    assert.equal(scroll.prevented, false, 'the page scrolls as it would anywhere else');
    assert.deepEqual(h.drain(), []);
});

test('a trackpad\'s many small deltas are one wheel notch', ()=>{
    const h = harness();
    h.canvas.fire('focus', {});
    h.drain();
    h.canvas.fire('wheel', { deltaY: 40, deltaMode: 0 });
    h.canvas.fire('wheel', { deltaY: 40, deltaMode: 0 });
    assert.deepEqual(h.drain(), [], 'not yet a notch');

    const event = h.canvas.fire('wheel', { deltaY: 40, deltaMode: 0 });
    assert.equal(event.prevented, true, 'the page does not scroll under the game');
    assert.deepEqual(h.drain(), [{ kind: 'wheel', delta: -120 }],
        'and a browser counts downwards the other way round');
});

test('the right button opens no menu', ()=>{
    const h = harness();
    assert.equal(h.canvas.fire('contextmenu', {}).prevented, true);
});

test('detaching leaves nothing listening and lets go of everything held', ()=>{
    const h = harness();
    h.canvas.fire('focus', {});
    h.drain();

    h.adapter.detach();
    assert.equal(h.canvas.listenerCount(), 0);
    assert.equal(h.canvas.style.outline, '');
    assert.deepEqual(h.drain(), [{ kind: 'focus', gained: false }]);

    h.canvas.fire('keydown', { code: 'KeyA', key: 'a' });
    assert.deepEqual(h.drain(), [], 'and a later event reaches nothing');
});

test('polling reads the pad only while the game has focus', ()=>{
    const h = harness();
    const pad = {
        axes: [0, 0.5],
        buttons: [{ pressed: false }, { pressed: true }],
    };
    const navigator = /** @type {any} */ (globalThis.navigator);
    Object.defineProperty(navigator, 'getGamepads',
        { value: ()=>[null, pad], configurable: true });
    try
    {
        h.adapter.poll();
        assert.deepEqual(h.drain(), [], 'an unfocused page is not one to read a pad for');

        h.canvas.fire('focus', {});
        h.drain();
        h.adapter.poll();
        assert.deepEqual(h.drain(), [
            { kind: 'padAxis', axis: 1, value: 0.5 },
            { kind: 'padButton', index: 1, down: true },
        ]);

        h.adapter.poll();
        assert.deepEqual(h.drain(), [], 'a pad that has not moved is not news');

        pad.axes[1] = -0.5;
        pad.buttons[1] = { pressed: false };
        h.adapter.poll();
        assert.deepEqual(h.drain(), [
            { kind: 'padAxis', axis: 1, value: -0.5 },
            { kind: 'padButton', index: 1, down: false },
        ]);
    }
    finally
    {
        delete navigator.getGamepads;
    }
});
