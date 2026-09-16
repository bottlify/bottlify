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
    h.canvas.fire('pointermove', { clientX: 0, clientY: 0, movementX: 0, movementY: 0 });
    h.drain();
    h.canvas.fire('pointermove', { clientX: 1, clientY: 0, movementX: 1, movementY: 0 });
    assert.equal(h.drain()[0].dx, 0, 'half a game pixel is not a pixel yet');
    h.canvas.fire('pointermove', { clientX: 2, clientY: 0, movementX: 1, movementY: 0 });
    assert.equal(h.drain()[0].dx, 1, 'and the other half arrives');
});

test('motion is the difference between two positions, not the browser\'s own number', ()=>{
    // A browser reports the position in CSS pixels and the movement in the
    // screen's own, so on a display at anything but 100% the two disagree by
    // the device pixel ratio. A program that draws its cursor by adding up
    // deltas -- which is what DirectInput hands it -- then drifts further from
    // the pointer the further it travels, while every absolute position it
    // could have asked for stays exactly right. Here the browser overstates
    // movement by half again, as a display at 150% does.
    const h = harness({ canvas: {
        width: 800, height: 600, rect: { left: 0, top: 0, width: 800, height: 600 },
    } });
    h.canvas.fire('focus', {});
    h.drain();
    h.canvas.fire('pointermove', { clientX: 0, clientY: 0, movementX: 0, movementY: 0 });
    h.drain();

    let travelled = 0;
    for (let step = 1; step <= 8; step++)
    {
        h.canvas.fire('pointermove',
            { clientX: step * 50, clientY: step * 30, movementX: 75, movementY: 45 });
        travelled += h.drain()[0].dx;
    }
    assert.equal(travelled, 400,
        'eight steps of fifty pixels are four hundred pixels, whatever the browser calls them');
});

test('a button takes focus, captures the pointer and is named', ()=>{
    const h = harness();
    const event = h.canvas.fire('pointerdown', { button: 2, pointerId: 7 });
    assert.equal(event.prevented, true);
    assert.equal(h.canvas.focused, 1, 'clicking in is the gesture that means "playing now"');
    assert.deepEqual(h.canvas.captured, [7], 'so the release lands here even off the canvas');
    assert.equal(h.drain().at(-1).button, 'right');

    h.canvas.fire('pointerup', { button: 2, pointerId: 7 });
    assert.deepEqual(h.drain().at(-1), { kind: 'pointerButton', button: 'right', down: false });
});

test('a press says where it happened, even with no move before it', ()=>{
    const h = harness();
    h.canvas.fire('pointerdown', { button: 0, pointerId: 1, clientX: 200, clientY: 150 });

    // A mouse always moves before it is pressed, so this only shows up for a
    // touch, a pen or a synthesised click -- where the program would otherwise
    // hit-test the press against wherever the pointer was left last.
    const sent = h.drain();
    const moved = sent.find(event=>event.kind === 'pointerMove');
    assert.ok(moved, 'the press carries the position with it');
    assert.equal(moved.x, 200);
    assert.equal(moved.y, 150);
    assert.deepEqual(sent.at(-1), { kind: 'pointerButton', button: 'left', down: true },
        'and the button still arrives after it, never before');
});

test('the pointer is only locked when the caller asked for that', ()=>{
    const plain = harness();
    plain.canvas.fire('pointerdown', { button: 0, pointerId: 1 });
    assert.equal(plain.canvas.locks, 0, 'never on its own');

    const locking = harness({ pointerLock: true });
    locking.canvas.fire('pointerdown', { button: 0, pointerId: 1 });
    assert.equal(locking.canvas.locks, 1, 'and only from inside the gesture');
});

test('the page keeps its scroll over a canvas nobody is playing', ()=>{
    const h = harness();
    const scroll = h.canvas.fire('wheel', { deltaY: 400, deltaMode: 0 });
    assert.equal(scroll.prevented, false, 'the page scrolls as it would anywhere else');
    assert.deepEqual(h.drain(), []);
});

test('the mouse keeps moving when the focus went to a panel beside the game', ()=>{
    // Clicking a settings panel is a page event and the program has no business
    // hearing about it. A cursor that stops until the viewport is clicked again
    // is the page telling the guest about itself.
    const h = harness({ canvas: {
        width: 640, height: 480, rect: { left: 0, top: 0, width: 640, height: 480 },
    } });
    h.canvas.fire('focus', {});
    h.drain();
    h.canvas.fire('blur', {});
    h.drain();

    h.canvas.fire('pointermove', { clientX: 320, clientY: 240, movementX: 4, movementY: 2 });
    assert.deepEqual(h.drain(),
        [{ kind: 'pointerMove', x: 320, y: 240, dx: 4, dy: 2 }]);
});

test('a border and padding are page furniture, not part of the picture', ()=>{
    // getBoundingClientRect answers with the border box; a canvas draws into its
    // content box. Left in, a single-pixel border moves the origin and stretches
    // the ratio -- which is a cursor that drifts further off the further it goes.
    const style = {
        borderLeftWidth: '1px', borderRightWidth: '1px',
        borderTopWidth: '1px', borderBottomWidth: '1px',
        paddingLeft: '4px', paddingRight: '4px',
        paddingTop: '2px', paddingBottom: '2px',
    };
    const before = globalThis.getComputedStyle;
    globalThis.getComputedStyle = /** @type {any} */ (()=>style);
    try
    {
        // 800x600 of picture inside a box 10 wider and 6 taller than it.
        const h = harness({ canvas: {
            width: 800, height: 600,
            rect: { left: 100, top: 50, width: 810, height: 606 },
        } });
        h.canvas.fire('focus', {});
        h.drain();

        // The content box starts 5 right and 3 down of the border box's corner.
        h.canvas.fire('pointermove', { clientX: 105, clientY: 53 });
        const [origin] = h.drain();
        assert.deepEqual([origin.x, origin.y], [0, 0],
            'the picture starts inside the furniture, not at the border box');

        h.canvas.fire('pointermove', { clientX: 905, clientY: 653 });
        const [corner] = h.drain();
        assert.deepEqual([corner.x, corner.y], [800, 600],
            'and its far corner is 800 of picture later, not 810 of box');
    }
    finally
    {
        globalThis.getComputedStyle = before;
    }
});

test('a pointer reaches the far corner before, during and after fullscreen', ()=>{
    // Entering fullscreen draws the canvas larger and leaving it draws it
    // small again. The pointer must land on the same picture pixel each time:
    // a projection that keeps a box from the previous phase maps the corner of
    // the picture to a position short of it, which from the chair is a cursor
    // that cannot reach the bottom-right.
    const rect = { left: 30, top: 20, width: 802, height: 602 };
    const style = {
        borderLeftWidth: '1px', borderRightWidth: '1px',
        borderTopWidth: '1px', borderBottomWidth: '1px',
        paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px',
    };
    const before = globalThis.getComputedStyle;
    globalThis.getComputedStyle = /** @type {any} */ (()=>style);
    try
    {
        const h = harness({ canvas: { width: 800, height: 600, rect } });
        h.canvas.fire('focus', {});
        h.drain();

        const corner = ()=>{
            const content = { width: rect.width - 2, height: rect.height - 2 };
            h.canvas.fire('pointermove', {
                clientX: rect.left + 1 + content.width - 1,
                clientY: rect.top + 1 + content.height - 1,
            });
            const [seen] = h.drain();
            return [seen.x, seen.y];
        };

        // Windowed: 800x600 of picture drawn one-to-one.
        assert.deepEqual(corner(), [799, 599], 'the windowed corner');
        // Fullscreen: drawn twice the size, and twice the pixels behind it.
        rect.left = 0;
        rect.top = 0;
        rect.width = 1602;
        rect.height = 1202;
        h.canvas.width = 1600;
        h.canvas.height = 1200;
        assert.deepEqual(corner(), [1599, 1199], 'the fullscreen corner');
        // Back to the windowed size, and to the windowed picture.
        rect.left = 30;
        rect.top = 20;
        rect.width = 802;
        rect.height = 602;
        h.canvas.width = 800;
        h.canvas.height = 600;
        assert.deepEqual(corner(), [799, 599], 'the windowed corner again');
    }
    finally
    {
        globalThis.getComputedStyle = before;
    }
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

test('a pointer lands where it points, whatever size the canvas is drawn at', ()=>{
    // The ratio is the canvas's own pixels against the size it is really drawn
    // at on the page. Those pixels are the picture the person is looking at, so
    // they are the space the cursor lives in -- and the drawn size changes
    // whenever a panel opens or the window is dragged, which is why it is read
    // on every move rather than remembered.
    const h = harness({
        // Drawn at half size, as it is whenever a panel takes part of the width.
        canvas: { width: 800, height: 600, rect: { left: 20, top: 10, width: 400, height: 300 } },
    });
    h.canvas.fire('focus', {});
    h.drain();

    h.canvas.fire('pointermove', { clientX: 20 + 200, clientY: 10 + 150 });
    const [middle] = h.drain();
    assert.deepEqual([middle.x, middle.y], [400, 300],
        'the middle of the drawn box is the middle of the picture');

    h.canvas.fire('pointermove', { clientX: 20 + 400, clientY: 10 + 300 });
    const [corner] = h.drain();
    assert.deepEqual([corner.x, corner.y], [800, 600],
        'and its far corner is the picture’s far corner');
});

test('a canvas drawn larger than its pixels maps back down', ()=>{
    const h = harness({
        canvas: { width: 320, height: 240, rect: { left: 0, top: 0, width: 960, height: 720 } },
    });
    h.canvas.fire('focus', {});
    h.drain();

    h.canvas.fire('pointermove', { clientX: 480, clientY: 360 });
    const [seen] = h.drain();
    assert.deepEqual([seen.x, seen.y], [160, 120]);
});
