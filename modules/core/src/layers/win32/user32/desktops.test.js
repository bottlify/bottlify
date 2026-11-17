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
    const fns = createDesktopFunctions({ host, topLevel: ()=>[],
        windowOf: hwnd=>(hwnd === 0x10010 ? { exStyle: 0 } : null) });
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
    return { fns, errors, caller, put, u32, text, table, bytes };
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
    // The interactive station is visible: .NET's UserInteractive reads this,
    // and WinForms refuses to show a box from a station that is not.
    fns.GetUserObjectInformationW.handler([station, UOI_FLAGS, OUT, 12, NEEDED]);
    assert.equal(u32(OUT + 8), 1, 'WinSta0 has WSF_VISIBLE');

    assert.equal(fns.GetUserObjectInformationW.handler([desktop, UOI_NAME, OUT, 4, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(u32(NEEDED), ('Default'.length + 1) * 2);
    assert.equal(fns.GetUserObjectInformationA.handler([0x9999, UOI_NAME, OUT, 64, NEEDED]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a window station made beside WinSta0, opened by its name and set as the process\'s', ()=>{
    // As a sandbox makes an alternate station for the processes it starts.
    const { fns, text, put } = setup();
    const made = fns.CreateWindowStationA.handler([0, 0, 0x37f, 0]);
    assert.notEqual(made, 0);
    fns.GetUserObjectInformationA.handler([made, UOI_NAME, OUT, 64, NEEDED]);
    const name = text(OUT);
    assert.match(name, /^Service-0x0-[0-9a-f]+\$$/, 'an unnamed station gets a service\'s name');
    assert.notEqual(fns.OpenWindowStationA.handler([put(name), 0, 0x37f]), 0);
    const named = fns.CreateWindowStationA.handler([put('Sandbox'), 0, 0x37f, 0]);
    assert.notEqual(fns.OpenWindowStationA.handler([put('sandbox'), 0, 0x37f]), 0,
        'found again without regard to case');
    assert.equal(fns.SetProcessWindowStation.handler([named]), 1);
    const now = fns.GetProcessWindowStation.handler();
    fns.GetUserObjectInformationA.handler([now, UOI_NAME, OUT, 64, NEEDED]);
    assert.equal(text(OUT), 'Sandbox');
    assert.equal(fns.CloseWindowStation.handler([made]), 1);
});

test('the message filter: accepted for the process; for a window, what was let in is told', ()=>{
    const { fns, bytes, errors } = setup();
    const view = new DataView(bytes.buffer);
    assert.equal(fns.ChangeWindowMessageFilter.handler([0x4a, 1]), 1);
    assert.equal(fns.ChangeWindowMessageFilter.handler([0x4a, 3]), 0);
    assert.equal(errors.at(-1), 87);
    const STRUCT = 0x2000;
    view.setUint32(STRUCT, 8, true);
    assert.equal(fns.ChangeWindowMessageFilterEx.handler([0x10010, 0x4a, 1, STRUCT]), 1);
    assert.equal(view.getUint32(STRUCT + 4, true), 0);
    fns.ChangeWindowMessageFilterEx.handler([0x10010, 0x4a, 1, STRUCT]);
    assert.equal(view.getUint32(STRUCT + 4, true), 1, 'already allowed for the window');
    fns.ChangeWindowMessageFilterEx.handler([0x10010, 0x4a, 2, STRUCT]);
    fns.ChangeWindowMessageFilterEx.handler([0x10010, 0x4a, 2, STRUCT]);
    assert.equal(view.getUint32(STRUCT + 4, true), 2, 'already disallowed');
    assert.equal(fns.ChangeWindowMessageFilterEx.handler([0x20020, 0x4a, 1, 0]), 0);
    assert.equal(errors.at(-1), 1400, 'no such window');
    view.setUint32(STRUCT, 12, true);
    assert.equal(fns.ChangeWindowMessageFilterEx.handler([0x10010, 0x4a, 1, STRUCT]), 0,
        'a structure of another size');
});

/**
 * The functions over a host that runs a callback: it records the name it was
 * handed and answers the lParam it was given.
 *
 * @param {string[]} seen @param {Uint8Array} bytes
 */
function setupWithCalls(seen, bytes){
    let free = 0x3c00;
    return createDesktopFunctions({ topLevel: ()=>[], host: {
        readMemory: (at, length)=>bytes.slice(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readCString: ()=>'',
        handles: { open: ()=>0x80, close: ()=>{} },
        allocate: size=>{
            const at = free;
            free += size + 4;
            return at;
        },
        release: ()=>{},
        call: (entry, [name, lParam])=>{
            let end = name;
            while (bytes[end] !== 0)
            {
                end++;
            }
            seen.push(String.fromCharCode(...bytes.subarray(name, end)));
            return lParam;
        },
    } });
}

test('an enumeration answers its callback\'s last answer, and the flags and security are set',
    async()=>{
        const { fns, u32, errors, bytes } = setup();
        /** @type {string[]} */
        const seen = [];
        const station = fns.GetProcessWindowStation.handler();
        const withCalls = setupWithCalls(seen, bytes);
        assert.equal(await withCalls.EnumWindowStationsA.handler([0x401000, 0x12345]), 0x12345,
            'the lParam a callback hands back comes back');
        assert.deepEqual(seen, ['WinSta0']);
        assert.equal(await withCalls.EnumDesktopsA.handler([0, 0x401000, 0]), 0,
            'a callback answering FALSE ends it, and that is the answer');

        new DataView(bytes.buffer).setUint32(OUT, 1, true);
        new DataView(bytes.buffer).setUint32(OUT + 8, 1, true);
        assert.equal(fns.SetUserObjectInformationW.handler([station, UOI_FLAGS, OUT, 12]), 1);
        fns.GetUserObjectInformationA.handler([station, UOI_FLAGS, OUT + 0x100, 12, NEEDED]);
        assert.equal(u32(OUT + 0x108), 1, 'WSF_VISIBLE kept');
        assert.equal(fns.SetUserObjectInformationA.handler([station, UOI_NAME, OUT, 12]), 0);
        assert.equal(errors.at(-1), 87);

        const ASKED = 0x3800;
        new DataView(bytes.buffer).setUint32(ASKED, 4, true);
        assert.equal(fns.GetUserObjectSecurity.handler([station, ASKED, 0, 0, NEEDED]), 0);
        assert.equal(errors.at(-1), ERROR_INSUFFICIENT_BUFFER);
        assert.equal(u32(NEEDED), 48, 'header, DACL, one ACE for everyone');
        assert.equal(fns.GetUserObjectSecurity.handler([station, ASKED, OUT, 500, NEEDED]), 1);
        assert.equal(bytes[OUT], 1, 'revision 1');
        assert.equal(u32(OUT + 16), 20, 'the DACL just past the header');
    });
