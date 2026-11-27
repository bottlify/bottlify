/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDpiFunctions, createDpiState, processAwareness, setProcessAwareness }
    from './dpi.js';

const UNAWARE = -1 >>> 0;
const SYSTEM_AWARE = -2 >>> 0;
const PER_MONITOR_V2 = -4 >>> 0;

function setup(){
    const errors = /** @type {number[]} */ ([]);
    let thread = 1;
    const state = createDpiState();
    /** @type {Record<string, { handler: (args: number[]) => number }>} */
    const fns = createDpiFunctions(state, { setLastError: code=>errors.push(code),
        callerThread: ()=>thread, isWindow: hwnd=>hwnd === 0x10010 });
    return { fns, state, errors, on: (/** @type {number} */ id)=>{ thread = id; } };
}

test('a process is unaware until it says otherwise, and says so once', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.IsProcessDPIAware.handler([]), 0);
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x6010, 'unaware at 96 DPI');
    assert.equal(fns.SetProcessDPIAware.handler([]), 1);
    assert.equal(fns.IsProcessDPIAware.handler([]), 1);
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x6011, 'system aware at 96');
    assert.equal(fns.SetProcessDpiAwarenessContext.handler([PER_MONITOR_V2]), 0, 'set already');
    assert.deepEqual(errors, [5]);
    assert.equal(fns.SetProcessDpiAwarenessContext.handler([0x1234]), 0, 'no such context');
    assert.deepEqual(errors, [5, 87]);
});

test('a thread\'s own context is its own, and Set hands back the one before', ()=>{
    const { fns, on } = setup();
    assert.equal(fns.SetThreadDpiAwarenessContext.handler([PER_MONITOR_V2]), 0x6010);
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x22);
    on(2);
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x6010, 'another thread');
    on(1);
    assert.equal(fns.SetThreadDpiAwarenessContext.handler([7]), 0, 'no such context');
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x22, 'kept');
});

test('contexts compare by what they are, pseudo-handle or value alike', ()=>{
    const { fns } = setup();
    assert.equal(fns.AreDpiAwarenessContextsEqual.handler([UNAWARE, 0x6010]), 1);
    assert.equal(fns.AreDpiAwarenessContextsEqual.handler([SYSTEM_AWARE, 0x6011]), 1);
    assert.equal(fns.AreDpiAwarenessContextsEqual.handler([-3 >>> 0, PER_MONITOR_V2]), 0,
        'per monitor and per monitor v2 differ');
    assert.equal(fns.AreDpiAwarenessContextsEqual.handler([9, 9]), 0, 'none equals none');
    assert.equal(fns.IsValidDpiAwarenessContext.handler([-5 >>> 0]), 1);
    assert.equal(fns.IsValidDpiAwarenessContext.handler([0]), 0);
    assert.equal(fns.GetAwarenessFromDpiAwarenessContext.handler([PER_MONITOR_V2]), 2);
    assert.equal(fns.GetAwarenessFromDpiAwarenessContext.handler([0]), -1);
    assert.equal(fns.GetDpiFromDpiAwarenessContext.handler([SYSTEM_AWARE]), 96);
});

test('the system and a window are at 96 DPI; a handle that is no window has none', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetDpiForSystem.handler([]), 96);
    assert.equal(fns.GetDpiForWindow.handler([0x10010]), 96);
    assert.equal(fns.GetDpiForWindow.handler([0x10020]), 0);
    assert.equal(fns.GetWindowDpiAwarenessContext.handler([0x10010]), 0x6010);
    assert.equal(fns.GetWindowDpiAwarenessContext.handler([0x10020]), 0);
});

test('shcore\'s awareness is user32\'s: one state for both', ()=>{
    const { fns, state } = setup();
    assert.equal(setProcessAwareness(state, 2), true);
    assert.equal(fns.GetThreadDpiAwarenessContext.handler([]), 0x12, 'per monitor');
    assert.equal(fns.SetProcessDPIAware.handler([]), 1, 'answers TRUE, changes nothing');
    assert.equal(processAwareness(state), 2);
});
