/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFunctions } from './desktops.js';

const NAME = 0x1000;
const OUT = 0x2000;
const NEEDED = 0x3000;

const UOI_FLAGS = 1;
const UOI_NAME = 2;
const UOI_TYPE = 3;
const UOI_IO = 6;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_BUSY = 170;

function setup(){
    const bytes = new Uint8Array(0x4000);
    let next = 0x40;
    /** @type {Map<number, any>} */
    const table = new Map();
    /** @type {number[]} */
    const errors = [];
    const caller = { current: /** @type {unknown} */ ({ id: 1 }) };
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        readCString(/** @type {number} */ at){
            let end = at;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return String.fromCharCode(...bytes.subarray(at, end));
        },
        handles: {
            open: (/** @type {string} */ type, /** @type {any} */ object)=>{
                next += 4;
                table.set(next, { type, object });
                return next;
            },
            close: (/** @type {number} */ handle)=>table.delete(handle),
        },
        callerThread: ()=>caller.current,
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    };
    const fns = createDesktopFunctions({ host, topLevel: ()=>[] });
    /** @param {string} text */
    const put = text=>{
        bytes.set([...text].map(character=>character.charCodeAt(0)), NAME);
        bytes[NAME + text.length] = 0;
        return NAME;
    };
    const u32 = (/** @type {number} */ at)=>new DataView(bytes.buffer).getUint32(at, true);
    const text = (/** @type {number} */ at)=>{
        let end = at;
        while (bytes[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...bytes.subarray(at, end));
    };
    return { fns, errors, caller, put, u32, text, table };
}

test('a desktop made and switched to takes the input, and the input desktop can be reopened',
    ()=>{
        // The input test's run_in_desktop: OpenInputDesktop, CreateDesktopA,
        // SwitchDesktop to it and back, then CloseDesktop of both.
        const { fns, put, u32, text, errors } = setup();
        const original = fns.OpenInputDesktop.handler([0, 0, 0x1ff]);
        assert.notEqual(original, 0);
        assert.equal(
            fns.GetUserObjectInformationA.handler([original, UOI_NAME, OUT, 64, NEEDED]), 1);
        assert.equal(text(OUT), 'Default');
        assert.equal(u32(NEEDED), 'Default'.length + 1, 'the size wanted counts the terminator');

        const made = fns.CreateDesktopA.handler([put('WineTest Desktop'), 0, 0, 0, 0x1ff, 0]);
        assert.notEqual(made, 0);
        assert.equal(fns.SwitchDesktop.handler([made]), 1);
        const now = fns.OpenInputDesktop.handler([0, 0, 0x1ff]);
        fns.GetUserObjectInformationA.handler([now, UOI_NAME, OUT, 64, NEEDED]);
        assert.equal(text(OUT), 'WineTest Desktop');
        fns.GetUserObjectInformationA.handler([original, UOI_IO, OUT, 4, NEEDED]);
        assert.equal(u32(OUT), 0, 'the first no longer takes the input');

        assert.equal(fns.SwitchDesktop.handler([original]), 1);
        assert.equal(fns.CloseDesktop.handler([made]), 1);
        assert.equal(fns.CloseDesktop.handler([now]), 1);
        assert.equal(fns.CloseDesktop.handler([original]), 1);
        assert.equal(fns.CloseDesktop.handler([original]), 0, 'a handle closes once');
        assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    });

test('GetThreadDesktop hands out one handle per thread, which the thread cannot close', ()=>{
    const { fns, errors, caller, put } = setup();
    const first = fns.GetThreadDesktop.handler([1]);
    assert.notEqual(first, 0);
    assert.equal(fns.GetThreadDesktop.handler([1]), first, 'the same each time');
    assert.equal(fns.CloseDesktop.handler([first]), 0);
    assert.equal(errors.at(-1), ERROR_BUSY);

    const other = fns.CreateDesktopA.handler([put('Other'), 0, 0, 0, 0x1ff, 0]);
    caller.current = { id: 2 };
    assert.equal(fns.SetThreadDesktop.handler([other]), 1);
    assert.equal(fns.GetThreadDesktop.handler([2]), other);
    assert.equal(fns.CloseDesktop.handler([other]), 0, 'in use by the thread');
});

test('GetUserObjectInformation says the kind, the flags, and when the buffer is short', ()=>{
    const { fns, u32, text, errors } = setup();
    const desktop = fns.OpenInputDesktop.handler([0, 1, 0x1ff]);
    const station = fns.GetProcessWindowStation.handler();
    fns.GetUserObjectInformationA.handler([desktop, UOI_TYPE, OUT, 64, NEEDED]);
    assert.equal(text(OUT), 'Desktop');
    fns.GetUserObjectInformationA.handler([station, UOI_TYPE, OUT, 64, NEEDED]);
    assert.equal(text(OUT), 'WindowStation');
    fns.GetUserObjectInformationA.handler([station, UOI_NAME, OUT, 64, NEEDED]);
    assert.equal(text(OUT), 'WinSta0');
    fns.GetUserObjectInformationA.handler([desktop, UOI_FLAGS, OUT, 12, NEEDED]);
    assert.equal(u32(OUT), 1, 'opened inheritable');

    assert.equal(fns.GetUserObjectInformationW.handler([desktop, UOI_NAME, OUT, 4, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(u32(NEEDED), ('Default'.length + 1) * 2);
    assert.equal(fns.GetUserObjectInformationA.handler([0x9999, UOI_NAME, OUT, 64, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});
