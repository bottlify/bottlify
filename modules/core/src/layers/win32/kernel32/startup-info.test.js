/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STARTUPINFO, readStartupInfo, startupInfoBytes } from './startup-info.js';
import { createEnvironmentFunctions } from './environment.js';

/** A parent's STARTUPINFO, as Wine's kernel32 test_Startup fills it. */
function parentStartup({ flags = 1, desktop = 0, title = 0, handles = [0, 0, 0] } = {}){
    const bytes = new Uint8Array(STARTUPINFO.SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(STARTUPINFO.CB, STARTUPINFO.SIZE, true);
    view.setUint32(STARTUPINFO.DESKTOP, desktop, true);
    view.setUint32(STARTUPINFO.TITLE, title, true);
    view.setUint32(STARTUPINFO.X, 0x34343434, true);
    view.setUint32(STARTUPINFO.Y, 0x45454545, true);
    view.setUint32(STARTUPINFO.X_SIZE, 0x56565656, true);
    view.setUint32(STARTUPINFO.Y_SIZE, 0x67676767, true);
    view.setUint32(STARTUPINFO.X_COUNT_CHARS, 0x12121212, true);
    view.setUint32(STARTUPINFO.Y_COUNT_CHARS, 0x23232323, true);
    view.setUint32(STARTUPINFO.FILL_ATTRIBUTE, 0xa55a, true);
    view.setUint32(STARTUPINFO.FLAGS, flags, true);
    view.setUint16(STARTUPINFO.SHOW_WINDOW, 1, true);
    view.setUint32(STARTUPINFO.STD_INPUT, handles[0], true);
    view.setUint32(STARTUPINFO.STD_OUTPUT, handles[1], true);
    view.setUint32(STARTUPINFO.STD_ERROR, handles[2], true);
    return bytes;
}

const strings = new Map([[0x100, 'winsta0\\default'], [0x200, 'I\'m the title string'],
    [0x300, '']]);
/** @param {number} address */
const readText = address=>/** @type {string} */ (strings.get(address));

test('the child reads back every field its parent handed CreateProcess', ()=>{
    const record = readStartupInfo(parentStartup({ desktop: 0x100, title: 0x200 }), readText,
        null);
    assert.deepEqual(record, {
        flags: 1, x: 0x34343434, y: 0x45454545, xSize: 0x56565656, ySize: 0x67676767,
        xCountChars: 0x12121212, yCountChars: 0x23232323, fillAttribute: 0xa55a, showWindow: 1,
        desktop: 'winsta0\\default', title: 'I\'m the title string',
        stdInput: 0, stdOutput: 0, stdError: 0,
    });
    // And back into the structure, the strings where the child put them.
    const view = new DataView(startupInfoBytes(record, { desktop: 0x900, title: 0x980 }).buffer);
    const original = new DataView(parentStartup().buffer);
    for (const at of [STARTUPINFO.CB, STARTUPINFO.X, STARTUPINFO.Y, STARTUPINFO.X_SIZE,
        STARTUPINFO.Y_SIZE, STARTUPINFO.X_COUNT_CHARS, STARTUPINFO.Y_COUNT_CHARS,
        STARTUPINFO.FILL_ATTRIBUTE, STARTUPINFO.FLAGS])
    {
        assert.equal(view.getUint32(at, true), original.getUint32(at, true), `at ${at}`);
    }
    assert.equal(view.getUint16(STARTUPINFO.SHOW_WINDOW, true), 1);
    assert.equal(view.getUint32(STARTUPINFO.DESKTOP, true), 0x900);
    assert.equal(view.getUint32(STARTUPINFO.TITLE, true), 0x980);
});

test('a NULL desktop is the parent\'s, a NULL title none, an empty string itself', ()=>{
    assert.equal(readStartupInfo(parentStartup(), readText, 'winsta0\\default').desktop,
        'winsta0\\default');
    assert.equal(readStartupInfo(parentStartup(), readText, null).desktop, null);
    assert.equal(readStartupInfo(parentStartup(), readText, null).title, null);
    const empty = readStartupInfo(parentStartup({ desktop: 0x300, title: 0x300 }), readText,
        'winsta0\\default');
    assert.equal(empty.desktop, '');
    assert.equal(empty.title, '');
});

test('the standard handles are the child\'s only with STARTF_USESTDHANDLES', ()=>{
    const handles = [0xffffffff, 0x44, 0x48];
    assert.deepEqual(readStartupInfo(parentStartup({ flags: 0x101, handles }), readText, null)
        .stdInput, 0xffffffff);
    const without = readStartupInfo(parentStartup({ flags: 1, handles }), readText, null);
    assert.deepEqual([without.stdInput, without.stdOutput, without.stdError], [0, 0, 0]);
});

test('GetStartupInfoA and W answer the record, their strings in their width and kept', ()=>{
    const memory = new Uint8Array(0x2000);
    let next = 0x1000;
    const record = readStartupInfo(parentStartup({ desktop: 0x100, title: 0x200 }), readText,
        null);
    const fns = createEnvironmentFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readCString: ()=>'',
        readWideString: ()=>'',
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        setLastError: ()=>{},
        commandLine: ()=>'"C:\\app.exe"',
        environment: ()=>({}),
        startup: ()=>record,
    });
    const view = new DataView(memory.buffer);
    /** @param {number} at @param {boolean} wide */
    const text = (at, wide)=>{
        let out = '';
        for (let unit = wide ? view.getUint16(at, true) : memory[at]; unit !== 0;
            unit = wide ? view.getUint16(at, true) : memory[at])
        {
            out += String.fromCharCode(unit);
            at += wide ? 2 : 1;
        }
        return out;
    };

    fns.GetStartupInfoA.handler([0x10]);
    assert.equal(view.getUint32(0x10 + STARTUPINFO.FLAGS, true), 1);
    assert.equal(view.getUint32(0x10 + STARTUPINFO.X, true), 0x34343434);
    const title = view.getUint32(0x10 + STARTUPINFO.TITLE, true);
    assert.equal(text(title, false), 'I\'m the title string');
    assert.equal(text(view.getUint32(0x10 + STARTUPINFO.DESKTOP, true), false), 'winsta0\\default');
    fns.GetStartupInfoA.handler([0x80]);
    assert.equal(view.getUint32(0x80 + STARTUPINFO.TITLE, true), title, 'the same pointer again');

    fns.GetStartupInfoW.handler([0x100]);
    assert.equal(text(view.getUint32(0x100 + STARTUPINFO.TITLE, true), true),
        'I\'m the title string');
    assert.equal(fns.GetStartupInfoW.argBytes, 4);
});
