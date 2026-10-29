/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';

const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;

function machine(){
    const memory = new Uint8Array(0x400).fill(0xaa);
    const view = new DataView(memory.buffer);
    /** @type {string[]} */
    const diverged = [];
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
    }));
    return { memory, view, diverged, shell };
}

test('application bars are kept along the edges, a later one clear of the earlier', ()=>{
    /** @type {number[][]} */
    const posted = [];
    const memory = new Uint8Array(0x400);
    const view = new DataView(memory.buffer);
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        library: name=>(name === 'USER32.dll' ? { PostMessageA: { handler: args=>{
            posted.push(args);
            return 1;
        } } } : undefined),
    }));
    const [ABM_NEW, ABM_REMOVE, ABM_QUERYPOS, ABM_SETPOS, ABM_GETTASKBARPOS] = [0, 1, 2, 3, 5];
    const [ABE_RIGHT, ABE_BOTTOM] = [2, 3];
    /**
     * @param {number} message @param {number} window @param {number} edge
     * @param {number[]} [rect]
     */
    const send = (message, window, edge = ABE_BOTTOM, rect = [0, 0, 0, 0])=>{
        view.setUint32(0x100, 36, true);
        view.setUint32(0x104, window, true);
        view.setUint32(0x108, 0x401, true);
        view.setUint32(0x10c, edge, true);
        rect.forEach((value, at)=>view.setInt32(0x110 + at * 4, value, true));
        return shell.SHAppBarMessage.handler([message, 0x100]);
    };
    const rect = ()=>[0, 1, 2, 3].map(at=>view.getInt32(0x110 + at * 4, true));
    assert.equal(send(ABM_NEW, 0x10), 1);
    assert.equal(send(ABM_NEW, 0x10), 0, 'once');
    assert.equal(send(ABM_NEW, 0x20), 1);
    assert.equal(send(ABM_QUERYPOS, 0x30), 0, 'a window that is no bar');
    assert.equal(send(ABM_SETPOS, 0x10, ABE_BOTTOM, [0, 465, 640, 480]), 1);
    assert.deepEqual(rect(), [0, 465, 640, 480], 'the first has its strip');
    assert.deepEqual(posted, [[0x20, 0x401, 1, 0]], 'the next is told: ABN_POSCHANGED');
    assert.equal(send(ABM_QUERYPOS, 0x20, ABE_BOTTOM, [0, 470, 640, 480]), 1);
    assert.deepEqual(rect(), [0, 470, 640, 465], 'the bottom moves, the top is the caller\'s');
    assert.equal(send(ABM_SETPOS, 0x20, ABE_RIGHT, [625, 0, 640, 480]), 1);
    assert.deepEqual(rect(), [625, 0, 640, 465], 'clear of an earlier bar on another edge');
    posted.length = 0;
    assert.equal(send(ABM_REMOVE, 0x10), 1);
    assert.deepEqual(posted, [[0x20, 0x401, 1, 0]], 'the bars after it are told');
    assert.equal(send(ABM_SETPOS, 0x20, ABE_RIGHT, [625, 0, 640, 480]), 1);
    assert.deepEqual(rect(), [625, 0, 640, 480], 'and have the room back');
    assert.equal(send(ABM_REMOVE, 0x10), 0);
    assert.equal(send(ABM_GETTASKBARPOS, 0), 0, 'there is no taskbar');
    assert.equal(shell.SHAppBarMessage.argBytes, 8);
});

test('SHGetSettings sets the bits asked for as a fresh profile has them', ()=>{
    const m = machine();
    const SSF_SHOWALLOBJECTS = 0x1;
    const SSF_SHOWEXTENSIONS = 0x2;
    const SSF_SHOWCOMPCOLOR = 0x8;
    const SSF_DOUBLECLICKINWEBVIEW = 0x80;
    const SSF_SHOWINFOTIP = 0x2000;
    m.view.setUint32(0x100, 0xffffffff, true);
    m.shell.SHGetSettings.handler([0x100, SSF_SHOWALLOBJECTS | SSF_SHOWEXTENSIONS]);
    assert.equal(m.view.getUint32(0x100, true), 0xfffffffc,
        'hidden files and known extensions hidden; the rest as they were');
    m.view.setUint32(0x100, 0, true);
    m.shell.SHGetSettings.handler([0x100, SSF_SHOWCOMPCOLOR | SSF_DOUBLECLICKINWEBVIEW
        | SSF_SHOWINFOTIP]);
    assert.equal(m.view.getUint32(0x100, true), 1 << 4 | 1 << 5 | 1 << 11);
    m.shell.SHGetSettings.handler([0, 0xffffffff]);
    assert.equal(m.shell.SHGetSettings.argBytes, 8);
});

test('the about box is answered as closed, Explorer\'s process as absent', ()=>{
    const m = machine();
    assert.equal(m.shell.ShellAboutA.handler([0, 0, 0, 0]), 1);
    assert.equal(m.shell.ShellAboutW.handler([0, 0, 0, 0]), 1);
    assert.equal(m.shell.ShellAboutW.argBytes, 16);
    m.view.setUint32(0x100, 0xdeadbeef, true);
    assert.equal(m.shell.SHGetInstanceExplorer.handler([0x100]), E_FAIL);
    assert.equal(m.view.getUint32(0x100, true), 0, 'a null interface');
    assert.equal(m.shell.SHGetInstanceExplorer.handler([0]), E_INVALIDARG);
    assert.equal(m.shell.SHLoadInProc.handler([0x100]), E_FAIL);
    assert.equal(m.shell.SHAddToRecentDocs.handler([2, 0x100]), 0);
    assert.deepEqual([m.shell.SHGetInstanceExplorer.argBytes, m.shell.SHLoadInProc.argBytes,
        m.shell.SHAddToRecentDocs.argBytes], [4, 4, 8]);
    assert.deepEqual(m.diverged.map(line=>line.split(':')[0]),
        ['ShellAbout', 'SHGetInstanceExplorer', 'SHLoadInProc', 'SHAddToRecentDocs']);
});
