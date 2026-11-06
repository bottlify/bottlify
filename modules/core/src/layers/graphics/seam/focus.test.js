/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFocusWindows } from './focus.js';

const FOCUS = 0x10010;
const DEVICE_WINDOW = 0x10020;
const PROGRAM_PROC = 0x401000;
const STUB = 0x7f0000;
const STATES = { OK: 'ok', LOST: 'lost', NOT_RESET: 'notreset' };

/** user32 as far as the focus window's hook calls it, every call recorded. */
function harness({ visible = false, foreground = 0, threads = {} } = {}){
    /** @type {[string, number[]][]} */
    const calls = [];
    /** @type {Map<number, number>} */
    const procs = new Map([[FOCUS, PROGRAM_PROC]]);
    let style = visible ? 0x10000000 : 0;
    let iconic = false;
    /** @type {((args: number[]) => unknown) | null} */
    let hook = null;
    /** @type {((args: number[]) => unknown) | null} */
    let nested = null;
    /** @type {Record<string, (args: number[]) => number>} */
    const table = {
        SetWindowLongA: ([hwnd, index, value])=>{
            const before = procs.get(hwnd) ?? 0;
            if (index === -4)
            {
                procs.set(hwnd, value);
            }
            return before;
        },
        GetWindowLongA: ([hwnd, index])=>(index === -4 ? procs.get(hwnd) ?? 0 : style),
        CallWindowProcA: ()=>0,
        DefWindowProcA: ()=>0,
        SetForegroundWindow: ()=>1,
        GetForegroundWindow: ()=>foreground,
        GetWindowThreadProcessId: ([hwnd])=>/** @type {Record<number, number>} */ (threads)[hwnd]
            ?? 1,
        // A broadcast reaches the focus window's procedure, among the others.
        SendMessageA: ([, message, wParam, lParam])=>Number(nested?.([FOCUS, message, wParam,
            lParam]) ?? 0),
        ChangeDisplaySettingsA: ()=>0,
        IsIconic: ()=>(iconic ? 1 : 0),
        ShowWindow: ([, command])=>{
            iconic = command === 6;
            // What the change makes reaches the focus window's procedure meanwhile.
            nested?.([FOCUS, 0x46, 0, 0]);
            nested?.([FOCUS, 0x7e, 0, 0]);
            return 1;
        },
        SetWindowPos: ([, , , , , , flags])=>{
            if ((flags & 0x40) !== 0)
            {
                style |= 0x10000000;
            }
            return 1;
        },
    };
    /** @type {number[]} */
    const covered = [];
    const windows = createFocusWindows({
        cover: hwnd=>{
            covered.push(hwnd);
        },
        user32: name=>({ handler: (/** @type {number[]} */ args)=>{
            calls.push([name, args]);
            return table[name](args);
        } }),
        procedure: (_, handler)=>{
            hook = handler;
            nested = handler;
            return STUB;
        },
        states: STATES,
    });
    const device = {
        deviceState: STATES.OK,
        occluded: false,
        /** @param {boolean} over */
        occlude(over){
            this.occluded = over;
        },
        /** @param {boolean} [restorable] */
        injectDeviceLoss(restorable = false){
            this.deviceState = restorable ? STATES.NOT_RESET : STATES.LOST;
        },
    };
    /** @param {number} message @param {number} wParam @param {number} [lParam] */
    const send = (message, wParam, lParam = 0)=>/** @type {(args: number[]) => unknown} */ (hook)(
        [FOCUS, message, wParam, lParam]);
    const hide = ()=>{
        style &= ~0x10000000;
    };
    return { windows, device, calls, procs, send, covered, hide,
        names: ()=>calls.map(([name])=>name) };
}

const HOW = { focus: FOCUS, window: DEVICE_WINDOW, fullscreen: true, noWindowChanges: false,
    extended: false, width: 640, height: 480, created: true };

test('a full-screen device hooks its focus window, activates it and shows its window', ()=>{
    const { windows, device, procs, names, calls, covered } = harness();
    windows.take(device, HOW);
    assert.equal(procs.get(FOCUS), STUB, 'the runtime\'s procedure is the window\'s');
    assert.ok(names().includes('SetForegroundWindow'));
    const placed = calls.find(([name])=>name === 'SetWindowPos');
    assert.deepEqual(placed?.[1].slice(0, 6), [DEVICE_WINDOW, 0xffffffff, 0, 0, 640, 480],
        'a hidden device window is placed at the mode\'s size, above the others (WS_EX_TOPMOST)');
    assert.equal((placed?.[1][6] ?? 0) & 0x40, 0x40, 'and shown');
    assert.deepEqual(covered, [DEVICE_WINDOW], 'its frame taking no room');
    windows.release(device);
    assert.equal(procs.get(FOCUS), PROGRAM_PROC, 'the program\'s procedure back');
});

test('a visible device window is only placed, and a windowed device hooks nothing', ()=>{
    const visible = harness({ visible: true });
    visible.windows.take(visible.device, HOW);
    assert.deepEqual(visible.calls.filter(([name])=>name === 'SetWindowPos').map(([, args])=>args),
        [[DEVICE_WINDOW, 0, 0, 0, 640, 480, 0x14]], 'the mode\'s size, where it is in the order');
    const windowed = harness();
    windowed.windows.take(windowed.device, { ...HOW, fullscreen: false });
    assert.equal(windowed.procs.get(FOCUS), PROGRAM_PROC);
    assert.deepEqual(windowed.names(), []);
});

test('losing the activation loses the device; regaining it waits for a Reset', ()=>{
    const { windows, device, send, names, calls } = harness();
    windows.take(device, HOW);
    calls.length = 0;
    send(0x1c, 0);
    assert.equal(device.deviceState, STATES.LOST);
    assert.deepEqual(names(), ['ChangeDisplaySettingsA', 'GetWindowLongA', 'ShowWindow',
        'DefWindowProcA', 'CallWindowProcA', 'SetWindowPos', 'CallWindowProcA'], 'the registry'
        + ' mode, the window minimised, shown as it is - what that makes is the default'
        + ' procedure\'s, a mode change aside - then the program hears it');
    calls.length = 0;
    send(0x1c, 1);
    assert.equal(device.deviceState, STATES.NOT_RESET);
    assert.deepEqual(names(), ['IsIconic', 'ShowWindow', 'DefWindowProcA', 'CallWindowProcA',
        'CallWindowProcA']);
    calls.length = 0;
    send(0x46, 0);
    assert.deepEqual(names(), ['CallWindowProcA'], 'the program\'s own changes are its to hear');
    device.deviceState = STATES.OK;
    send(0x7e, 0);
    assert.equal(device.deviceState, STATES.NOT_RESET, 'a mode set under it');
});

test('D3DCREATE_NOWINDOWCHANGES leaves the windows, an extended device is never lost', ()=>{
    const kept = harness();
    kept.windows.take(kept.device, { ...HOW, noWindowChanges: true });
    kept.calls.length = 0;
    kept.send(0x1c, 0);
    assert.deepEqual(kept.names(), ['ChangeDisplaySettingsA', 'CallWindowProcA']);
    assert.equal(kept.device.deviceState, STATES.LOST);
    const ex = harness();
    ex.windows.take(ex.device, { ...HOW, extended: true });
    ex.send(0x1c, 0);
    ex.send(0x7e, 0);
    assert.equal(ex.device.deviceState, STATES.OK);
});

test('SC_RESTORE is the default procedure\'s before the program hears it', ()=>{
    const { windows, device, send, names, calls } = harness();
    windows.take(device, HOW);
    calls.length = 0;
    send(0x112, 0xf120);
    assert.deepEqual(names(), ['DefWindowProcA', 'CallWindowProcA']);
});

test('a procedure the program set meanwhile stays at the last release', ()=>{
    const { windows, device, procs } = harness();
    windows.take(device, HOW);
    procs.set(FOCUS, 0x402000);
    windows.release(device);
    assert.equal(procs.get(FOCUS), 0x402000);
});

test('an extended device shows its window only from the second made on it, and keeps it'
    + ' out of the topmost band when the activation goes', ()=>{
    const SHOWN = 0x40;
    const first = harness({ visible: true });
    first.windows.take(first.device, { ...HOW, extended: true });
    assert.deepEqual(first.calls.filter(([name])=>name === 'SetWindowPos').map(([, args])=>args),
        [[DEVICE_WINDOW, 0, 0, 0, 640, 480, 0x14]], 'the first only places it');
    first.windows.release(first.device);
    const again = { ...first.device };
    first.calls.length = 0;
    first.windows.take(again, { ...HOW, extended: true });
    const placed = first.calls.find(([name])=>name === 'SetWindowPos');
    assert.ok(placed && placed[1][1] === 0xffffffff && (placed[1][6] & SHOWN) !== 0,
        'the second shows it above the others, shown already or not');
    first.calls.length = 0;
    first.send(0x1c, 0);
    assert.deepEqual(first.names().filter(name=>name === 'ShowWindow' || name === 'SetWindowPos'),
        ['ShowWindow'], 'minimised, not put above the others');

    const hidden = harness();
    hidden.windows.take(hidden.device, { ...HOW, extended: true });
    hidden.calls.length = 0;
    hidden.send(0x1c, 0);
    assert.equal(hidden.names().includes('ShowWindow'), false, 'a hidden window stays as it is');
});

test('a reset shows a device window hidden since, and places it at the new mode', ()=>{
    // Wine's d3d9 test_wndproc, mode_change_messages_hidden: the window
    // placed, then ShowWindow's own WINDOWPOS (SWP_SHOWWINDOW | SWP_NOMOVE |
    // SWP_NOSIZE, no window to go after).
    const { windows, device, calls, hide } = harness();
    windows.take(device, HOW);
    calls.length = 0;
    const RESET = { ...HOW, created: false, width: 800, height: 600 };
    windows.take(device, RESET);
    /** @returns {[string, number[]][]} */
    const placing = ()=>calls.splice(0).filter(([name])=>name === 'SetWindowPos'
        || name === 'ShowWindow');
    assert.deepEqual(placing(), [['SetWindowPos', [DEVICE_WINDOW, 0, 0, 0, 800, 600, 0x14]]],
        'shown already: only placed');
    // The program hides it, as World of Warplanes does, and resets.
    hide();
    windows.take(device, RESET);
    assert.deepEqual(placing(), [['SetWindowPos', [DEVICE_WINDOW, 0, 0, 0, 800, 600, 0x14]],
        ['ShowWindow', [DEVICE_WINDOW, 5]]]);
});

test('a mode the device sets is broadcast, and loses that device nothing', ()=>{
    const { windows, device, calls } = harness();
    windows.take(device, { ...HOW, mode: { bitsPerPixel: 32 } });
    const told = calls.find(([name])=>name === 'SendMessageA');
    assert.deepEqual(told?.[1], [0xffff, 0x7e, 32, (480 << 16 | 640) >>> 0],
        'WM_DISPLAYCHANGE to every window: the depth, the size');
    assert.equal(device.deviceState, STATES.OK);
    assert.ok(calls.some(([name, args])=>name === 'CallWindowProcA' && args[2] === 0x7e),
        'the program hears it');
    calls.length = 0;
    windows.take(device, { ...HOW, created: false });
    assert.equal(calls.some(([name])=>name === 'SendMessageA'), false, 'the same mode: nothing');
});

test('an extended device is told its window is covered while the activation is gone, and'
    + ' takes its mode back', ()=>{
    const { windows, device, calls, send } = harness();
    let found = { width: 1024, height: 768 };
    windows.take(device, { ...HOW, extended: true, reapply: ()=>{
        if (found.width === 640)
        {
            return null;
        }
        found = { width: 640, height: 480 };
        return { bitsPerPixel: 16 };
    } });
    send(0x1c, 0);
    assert.equal(device.occluded, true);
    assert.equal(device.deviceState, STATES.OK, 'and not lost');
    calls.length = 0;
    send(0x1c, 1);
    assert.equal(device.occluded, false);
    assert.deepEqual(calls.find(([name])=>name === 'SendMessageA')?.[1],
        [0xffff, 0x7e, 16, (480 << 16 | 640) >>> 0], 'its mode set again, and told');
    assert.equal(device.deviceState, STATES.OK);
    send(0x1c, 0);
    windows.take(device, { ...HOW, extended: true, created: false });
    assert.equal(device.occluded, false, 'a reset makes the window its own again');
});

test('DirectDraw\'s window: placed over the mode then made the foreground one, its changes'
    + ' heard, following every mode set, and given back from above the others', ()=>{
    const DDRAW = { focus: FOCUS, window: FOCUS, fullscreen: true, noWindowChanges: false,
        extended: false, width: 640, height: 480, created: true, announce: true };
    /** @param {ReturnType<typeof harness>} h */
    const placing = h=>h.calls.filter(([name])=>name === 'SetWindowPos'
        || name === 'SetForegroundWindow').map(([name, args])=>[name, ...args]);
    // Another thread's window has the foreground: shown, then made the foreground.
    const other = harness({ foreground: 0x30000, threads: { 0x30000: 2 } });
    other.windows.take(other.device, DDRAW);
    assert.deepEqual(placing(other), [['SetWindowPos', FOCUS, 0, 0, 0, 640, 480,
        0x10 | 0x40 | 0x4], ['SetForegroundWindow', FOCUS]]);
    assert.deepEqual(other.covered, [], 'its frame kept');
    // It had the foreground: above the others too.
    const own = harness({ foreground: FOCUS });
    own.windows.take(own.device, DDRAW);
    assert.deepEqual(placing(own)[0], ['SetWindowPos', FOCUS, 0xffffffff, 0, 0, 640, 480,
        0x10 | 0x40]);
    // Another window of its own thread has it: only placed.
    const sibling = harness({ foreground: 0x30000 });
    sibling.windows.take(sibling.device, DDRAW);
    assert.deepEqual(placing(sibling), [['SetWindowPos', FOCUS, 0, 0, 0, 640, 480, 0x10 | 0x4]]);

    const h = harness({ foreground: FOCUS });
    let regained = 0;
    h.windows.take(h.device, { ...DDRAW, regain: ()=>{
        regained++;
    } });
    // A mode set by anyone: the window at its size first, then the program hears it.
    h.calls.length = 0;
    h.send(0x7e, 32, (600 << 16 | 800) >>> 0);
    assert.deepEqual(h.calls.map(([name, args])=>[name, ...args.slice(0, 7)]), [
        ['SetWindowPos', FOCUS, 0, 0, 0, 800, 600, 0x10 | 0x4],
        ['CallWindowProcA', PROGRAM_PROC, FOCUS, 0x7e, 32, (600 << 16 | 800) >>> 0]]);
    // SC_RESTORE is the program's to carry out.
    h.calls.length = 0;
    h.send(0x112, 0xf120);
    assert.deepEqual(h.names(), ['CallWindowProcA']);
    // Losing the activation: the registry's mode and the window minimised, heard by
    // the program, which then hears it; nothing put above the others.
    h.calls.length = 0;
    h.send(0x1c, 0);
    assert.deepEqual(h.names().filter(name=>name !== 'GetWindowLongA'), ['ChangeDisplaySettingsA',
        'ShowWindow', 'CallWindowProcA', 'SetWindowPos', 'CallWindowProcA', 'CallWindowProcA'],
    'what the minimising and its mode make reach the program meanwhile');
    assert.equal(h.device.deviceState, STATES.LOST, 'its surfaces lost');
    // Back: its mode set again, which is all the object does with it.
    h.send(0x1c, 1);
    assert.equal(regained, 1);
    assert.equal(h.device.deviceState, STATES.LOST, 'no Reset for DirectDraw to wait for');
    // Given back: from above the others, unless it keeps its windows.
    h.calls.length = 0;
    h.windows.take(h.device, { ...DDRAW, fullscreen: false });
    assert.deepEqual(placing(h), [['SetWindowPos', FOCUS, 0xfffffffe, 0, 0, 0, 0,
        0x1 | 0x2 | 0x10]]);
});

test('DirectDraw keeps the procedure it found when the program set another, and gives that'
    + ' back at the end (test_wndproc)', ()=>{
    const DDRAW = { ...HOW, focus: FOCUS, window: FOCUS, announce: true };
    const { windows, device, procs } = harness({ foreground: FOCUS });
    windows.take(device, DDRAW);
    procs.set(FOCUS, 0x402000);
    windows.take(device, { ...DDRAW, fullscreen: false });
    assert.equal(procs.get(FOCUS), 0x402000, 'not the runtime\'s now: left');
    windows.take(device, DDRAW);
    assert.equal(procs.get(FOCUS), 0x402000, 'held again without setting its own');
    procs.set(FOCUS, STUB);
    windows.release(device);
    assert.equal(procs.get(FOCUS), PROGRAM_PROC, 'the procedure it first found');
});
