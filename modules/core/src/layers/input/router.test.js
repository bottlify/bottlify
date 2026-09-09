/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputRouter, WM } from './router.js';
import { keyFor, dikOf } from './keys.js';
import { createInputDevice, KEY_DOWN, DIMOUSE_OFS } from './dinput/devices.js';

const HWND = 0x1234;

/** The virtual keys and message parameters the assertions name. */
const VK_SHIFT = 0x10;
const VK_MENU = 0x12;
const MK_LBUTTON = 0x0001;
const MK_SHIFT = 0x0004;
const MK_CONTROL = 0x0008;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_XBUTTONDOWN = 0x020b;

/**
 * A router with both of its outputs recorded, and real DirectInput devices
 * behind the second: the point of the layer is that one event reaches both, so
 * a fake device would test half of it.
 *
 * @param {{ bounds?: (() => { width: number, height: number }) | null }} [options]
 */
function harness({ bounds = null } = {}){
    /** @type {any[]} */
    const messages = [];
    /** @type {any[]} */
    const raw = [];
    let clock = 0;

    const keyboard = createInputDevice({ kind: 'keyboard', now: ()=>clock });
    const mouse = createInputDevice({ kind: 'mouse', now: ()=>clock });
    keyboard.acquire();
    mouse.acquire();

    /** @type {{ character: number, lParam: number }[]} */
    const composed = [];
    const router = createInputRouter({
        post: message=>messages.push(message),
        /** @param {number} character @param {number} lParam */
        compose: (character, lParam)=>composed.push({ character, lParam }),
        device: event=>{
            raw.push(event);
            return event.kind === 'key' ? keyboard.post(event) : mouse.post(event);
        },
        now: ()=>clock,
        target: ()=>HWND,
        bounds,
    });

    return {
        router,
        messages,
        raw,
        keyboard,
        mouse,
        /** @param {number} value */
        setClock(value){
            clock = value;
        },
        /** @param {import('./router.js').HostInputEvent} event */
        send: event=>router.send(event),
        /** Everything since the last look, with the noise of a cursor question out. */
        drain(){
            const taken = messages.filter(entry=>entry.message !== WM.SETCURSOR);
            messages.length = 0;
            return taken;
        },
        all(){
            const taken = [...messages];
            messages.length = 0;
            return taken;
        },
        /** The characters handed to the queue for TranslateMessage to deliver. */
        composed(){
            const taken = [...composed];
            composed.length = 0;
            return taken;
        },
    };
}

test('a key down carries its virtual key, its scan code and a repeat count of one', ()=>{
    const h = harness();
    assert.equal(h.send({ kind: 'key', code: 'KeyA', down: true }), true);

    const [message] = h.drain();
    assert.equal(message.hwnd, HWND);
    assert.equal(message.message, WM.KEYDOWN);
    assert.equal(message.wParam, 0x41);
    // repeat 1, scan 0x1e, not extended, no context, was not down, going down.
    assert.equal(message.lParam, 0x001e0001);
});

test('a key up sets the previous-state and transition bits', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'KeyA', down: true });
    h.drain();
    h.send({ kind: 'key', code: 'KeyA', down: false });

    const [message] = h.drain();
    assert.equal(message.message, WM.KEYUP);
    assert.equal(message.lParam, 0xc01e0001);
});

test('a repeat reports that the key was already down', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'KeyA', down: true });
    h.drain();
    h.send({ kind: 'key', code: 'KeyA', down: true });

    const [message] = h.drain();
    assert.equal(message.lParam, 0x401e0001, 'previous state set, transition clear');
});

test('an extended key sets bit 24 and keeps the unprefixed scan code', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'ArrowLeft', down: true });

    const [message] = h.drain();
    assert.equal(message.wParam, 0x25, 'VK_LEFT');
    assert.equal(message.lParam, 0x014b0001);
});

test('ALT turns a key into a system key, and the context bit follows ALT itself', ()=>{
    const h = harness();

    h.send({ kind: 'key', code: 'AltLeft', down: true });
    assert.deepEqual(h.drain().map(m=>[m.message, m.wParam, m.lParam]),
        [[WM.SYSKEYDOWN, VK_MENU, 0x20380001]]);

    h.send({ kind: 'key', code: 'KeyA', down: true });
    assert.deepEqual(h.drain().map(m=>[m.message, m.wParam, m.lParam]),
        [[WM.SYSKEYDOWN, 0x41, 0x201e0001]]);

    h.send({ kind: 'key', code: 'KeyA', down: false });
    assert.deepEqual(h.drain().map(m=>[m.message, m.wParam, m.lParam]),
        [[WM.SYSKEYUP, 0x41, 0xe01e0001]]);

    // Releasing ALT is still a system message, but ALT is no longer down, so
    // the context bit is clear.
    h.send({ kind: 'key', code: 'AltLeft', down: false });
    assert.deepEqual(h.drain().map(m=>[m.message, m.wParam, m.lParam]),
        [[WM.SYSKEYUP, VK_MENU, 0xc0380001]]);
});

test('F10 is a system key with no ALT held', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'F10', down: true });
    assert.equal(h.drain()[0].message, WM.SYSKEYDOWN);
});

test('either shift is VK_SHIFT, and the pair is up only when both are', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'ShiftLeft', down: true });
    h.send({ kind: 'key', code: 'ShiftRight', down: true });
    assert.deepEqual(h.drain().map(m=>[m.wParam, m.lParam]),
        [[VK_SHIFT, 0x002a0001], [VK_SHIFT, 0x00360001]]);

    h.send({ kind: 'key', code: 'ShiftLeft', down: false });
    assert.equal(h.router.keyState(VK_SHIFT), 0x8000, 'the right one is still down');
    assert.equal(h.router.keyState(0xa0), 0, 'VK_LSHIFT is not');

    h.send({ kind: 'key', code: 'ShiftRight', down: false });
    assert.equal(h.router.keyState(VK_SHIFT), 0);
});

test('a key nothing maps is dropped rather than sent as some other key', ()=>{
    const h = harness();
    assert.equal(h.send({ kind: 'key', code: 'LaunchMail', down: true }), false);
    assert.deepEqual(h.drain(), []);
    assert.equal(h.router.diagnostics().dropped, 1);
});

// These three asserted that a text event posts a WM_CHAR of its own. That was
// wrong, and the program saw every keystroke twice: Windows makes a WM_CHAR
// inside TranslateMessage and nowhere else, so the character the host's layout
// composed is handed over for TranslateMessage to deliver, and delivered once.

test('text is composed against the key press it came from, not posted', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'KeyA', down: true });
    h.drain();
    h.send({ kind: 'text', text: 'A' });

    assert.deepEqual(h.composed(), [{ character: 0x41, lParam: 0x001e0001 }]);
    assert.deepEqual(h.drain(), [], 'and nothing is posted, or it arrives twice');
});

test('a character outside the basic plane is composed as two code units', ()=>{
    const h = harness();
    assert.equal(h.send({ kind: 'text', text: '\u{1f600}' }), true);
    assert.deepEqual(h.composed().map(entry=>entry.character), [0xd83d, 0xde00]);
    assert.deepEqual(h.drain(), []);
});

test('whether a character is a system one is TranslateMessage\'s to decide', ()=>{
    // It reads the message it was given: WM_SYSKEYDOWN makes a WM_SYSCHAR. The
    // router held ALT down and decided here, which is a second place for the
    // same decision to be made and disagree.
    const h = harness();
    h.send({ kind: 'key', code: 'AltLeft', down: true });
    h.send({ kind: 'key', code: 'KeyF', down: true });
    const [, keyDown] = h.drain();
    assert.equal(keyDown.message, WM.SYSKEYDOWN);

    h.send({ kind: 'text', text: 'f' });
    assert.deepEqual(h.composed().map(entry=>entry.character), [0x66]);
});

test('a pointer move packs client coordinates and reports what is held', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'ControlLeft', down: true });
    h.send({ kind: 'pointerButton', button: 'left', down: true });
    h.drain();

    h.send({ kind: 'pointerMove', x: 300, y: 200 });
    const [message] = h.drain();
    assert.equal(message.message, WM.MOUSEMOVE);
    assert.equal(message.wParam, MK_LBUTTON | MK_CONTROL);
    assert.equal(message.lParam, 200 << 16 | 300);
    assert.equal(message.x, 300, 'MSG.pt goes with it');
    assert.equal(message.y, 200);
});

test('a negative coordinate packs as a signed word', ()=>{
    const h = harness();
    h.send({ kind: 'pointerMove', x: -3, y: -1 });
    assert.equal(h.drain()[0].lParam, 0xfffffffd >>> 0);
});

test('an absolute move with no delta given still moves the DirectInput mouse', ()=>{
    const h = harness();
    h.send({ kind: 'pointerMove', x: 10, y: 10 });
    h.send({ kind: 'pointerMove', x: 14, y: 7 });

    const state = h.mouse.mouseState();
    assert.equal(state.x, 14, 'the first move is measured from the origin');
    assert.equal(state.y, 7);
    assert.deepEqual(h.mouse.mouseState(), { x: 0, y: 0, wheel: 0, buttons: state.buttons },
        'and reading consumed it');
});

test('a relative move with no position advances the cursor by the delta', ()=>{
    const h = harness();
    h.send({ kind: 'pointerMove', x: 100, y: 100 });
    h.drain();
    h.send({ kind: 'pointerMove', dx: 5, dy: -4 });

    assert.deepEqual(h.router.cursor(), { x: 105, y: 96 });
    assert.equal(h.mouse.mouseState().x, 105, 'the first move counted from zero, then five');
});

test('the cursor stays inside the client area when one is known', ()=>{
    const h = harness({ bounds: ()=>({ width: 640, height: 480 }) });
    h.send({ kind: 'pointerMove', x: 900, y: -20 });
    assert.deepEqual(h.router.cursor(), { x: 639, y: 0 });
});

test('a button posts its own message pair and reaches the DirectInput mouse', ()=>{
    const h = harness();
    h.send({ kind: 'pointerMove', x: 8, y: 9 });
    h.drain();

    h.send({ kind: 'pointerButton', button: 'left', down: true });
    const [down] = h.drain();
    assert.equal(down.message, WM_LBUTTONDOWN);
    assert.equal(down.wParam, MK_LBUTTON, 'the button being pressed is in the mask');
    assert.equal(down.lParam, 9 << 16 | 8);

    h.send({ kind: 'pointerButton', button: 'left', down: false });
    const [up] = h.drain();
    assert.equal(up.message, WM_LBUTTONUP);
    assert.equal(up.wParam, 0, 'and is gone from it on the way up');

    assert.deepEqual(h.raw.filter(event=>event.kind === 'mouseButton'),
        [{ kind: 'mouseButton', code: 0, down: true },
            { kind: 'mouseButton', code: 0, down: false }]);
});

test('the right button is DirectInput button one, not two', ()=>{
    const h = harness();
    h.send({ kind: 'pointerButton', button: 'right', down: true });
    assert.equal(h.drain()[0].message, WM_RBUTTONDOWN);
    assert.equal(h.mouse.mouseState().buttons[1], KEY_DOWN);
});

test('an X button names itself in the high word', ()=>{
    const h = harness();
    h.send({ kind: 'pointerButton', button: 'x1', down: true });
    const [message] = h.drain();
    assert.equal(message.message, WM_XBUTTONDOWN);
    assert.equal(message.wParam >>> 16, 1);
    assert.equal(message.wParam & 0xffff, 0x20, 'MK_XBUTTON1');
});

test('the wheel reports notches in the high word and the same to DirectInput', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'ShiftLeft', down: true });
    h.drain();
    h.send({ kind: 'wheel', delta: -120 });

    const [message] = h.drain();
    assert.equal(message.message, WM.MOUSEWHEEL);
    assert.equal(message.wParam >> 16, -120);
    assert.equal(message.wParam & 0xffff, MK_SHIFT);
    assert.equal(h.mouse.mouseState().wheel, -120);
});

test('a key reaches DirectInput as its own code, extended keys included', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'KeyA', down: true });
    h.send({ kind: 'key', code: 'ArrowLeft', down: true });

    const state = h.keyboard.keyboardState();
    assert.equal(state[0x1e], KEY_DOWN, 'DIK_A');
    assert.equal(state[0xcb], KEY_DOWN, 'DIK_LEFT is the scan code plus 0x80');
    assert.equal(dikOf(/** @type {any} */ (keyFor('ArrowLeft'))), 0xcb);
});

test('buffered DirectInput sees the same events, in order', ()=>{
    const h = harness();
    h.mouse.setBufferSize(16);
    h.setClock(7);
    h.send({ kind: 'pointerMove', dx: 3, dy: 0 });
    h.send({ kind: 'pointerButton', button: 'left', down: true });

    const { events } = h.mouse.drain(8);
    assert.deepEqual(events.map(entry=>[entry.offset, entry.data, entry.time]),
        [[DIMOUSE_OFS.X, 3, 7], [DIMOUSE_OFS.BUTTON0, KEY_DOWN, 7]]);
});

test('gaining focus tells the program nothing at all', ()=>{
    // It used to send the activation trio. Focus is the page's business: it
    // decides whether this element receives keystrokes, and a program has no
    // reason to hear about it. Activation is sent once by `arm`, below.
    const h = harness();
    h.send({ kind: 'focus', gained: true });
    assert.deepEqual(h.drain(), []);
});

test('losing focus releases every held key and button, and says nothing else', ()=>{
    // This test used to expect WM_KILLFOCUS, WM_ACTIVATE and WM_ACTIVATEAPP
    // after the releases, and that expectation was the bug written down. The
    // page's focus is a page concern -- it decides whether this element gets
    // keystrokes -- and it is not the program's window activation: somebody
    // clicking a button beside the canvas takes it away without anything having
    // happened to the program. A program told it went to the background acts on
    // it, by pausing itself or abandoning a cinematic, and it would be acting on
    // something that happened to a web page. A virtual machine does not tell the
    // programs inside it to stand down because its own window was minimised.
    const h = harness();
    h.send({ kind: 'focus', gained: true });
    h.send({ kind: 'key', code: 'KeyW', down: true });
    h.send({ kind: 'key', code: 'ShiftLeft', down: true });
    h.send({ kind: 'pointerButton', button: 'left', down: true });
    h.drain();

    h.send({ kind: 'focus', gained: false });
    const posted = h.drain();
    assert.deepEqual(posted.map(m=>[m.message, m.wParam]), [
        [WM.KEYUP, 0x57],
        [WM.KEYUP, VK_SHIFT],
        [WM_LBUTTONUP, 0],
    ]);

    // And the other reading agrees: a program polling DirectInput must not
    // find a key held down that the message queue has already released.
    assert.deepEqual([...h.keyboard.keyboardState()].filter(byte=>byte !== 0), []);
    assert.deepEqual([...h.mouse.mouseState().buttons].filter(byte=>byte !== 0), []);
    assert.equal(h.router.keyState(VK_SHIFT), 0);
    assert.deepEqual(h.router.diagnostics().keysDown, []);
});

test('a released key is not released twice when focus goes away', ()=>{
    const h = harness();
    h.send({ kind: 'key', code: 'KeyW', down: true });
    h.send({ kind: 'key', code: 'KeyW', down: false });
    h.drain();

    h.send({ kind: 'focus', gained: false });
    assert.deepEqual(h.drain(), []);
});

test('the program is told it is active once, when input is wired to a window', ()=>{
    // There is one window in this machine and it is the active one. The
    // activation a program waits for before it will do anything is owed to it,
    // so it is sent once -- when input is wired to a window, not when a page
    // gains focus, which would be the browser deciding it. And it
    // is never taken back, however often the page loses its focus afterwards.
    const h = harness();
    h.router.arm();
    h.router.arm();
    assert.deepEqual(h.drain().map(m=>[m.message, m.wParam]),
        [[WM.ACTIVATEAPP, 1], [WM.ACTIVATE, 1], [WM.SETFOCUS, 0]]);

    h.send({ kind: 'focus', gained: false });
    h.send({ kind: 'focus', gained: true });
    h.send({ kind: 'focus', gained: false });
    assert.deepEqual(h.drain(), [], 'and the page losing focus says nothing');
});

test('the cursor question is asked when the answer could have changed, not per move', ()=>{
    const h = harness();
    h.send({ kind: 'focus', gained: true });
    h.all();

    h.send({ kind: 'pointerMove', x: 1, y: 1 });
    h.send({ kind: 'pointerMove', x: 2, y: 2 });
    h.send({ kind: 'pointerMove', x: 3, y: 3 });
    const moves = h.all();
    const asked = moves.filter(entry=>entry.message === WM.SETCURSOR);
    assert.equal(asked.length, 1, 'once, on the first move after focus arrived');
    assert.equal(asked[0].wParam, HWND);
    assert.equal(asked[0].lParam, WM.MOUSEMOVE << 16 | 1, 'HTCLIENT, and what it precedes');
    assert.equal(moves.indexOf(asked[0]), 0, 'and before the move it is about');

    h.send({ kind: 'pointerButton', button: 'left', down: true });
    assert.equal(h.all()[0].message, WM.SETCURSOR, 'a button asks again');
});

test('a pad is remembered even though nothing reads it yet', ()=>{
    const h = harness();
    h.send({ kind: 'padAxis', axis: 1, value: -0.5 });
    h.send({ kind: 'padButton', index: 2, down: true });
    assert.deepEqual(h.router.pad(),
        { axes: [undefined, -0.5], buttons: [undefined, undefined, 1] });
    assert.deepEqual(h.drain(), [], 'and produces no messages: Windows posts none either');
});

test('every message carries the guest clock it happened at', ()=>{
    const h = harness();
    h.setClock(4321);
    h.send({ kind: 'key', code: 'Space', down: true });
    assert.equal(h.drain()[0].time, 4321);
});
