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

test('SHAppBarMessage answers FALSE to every message: there is no taskbar', ()=>{
    const m = machine();
    const ABM_NEW = 0;
    const ABM_GETSTATE = 4;
    const ABM_GETTASKBARPOS = 5;
    const ABM_GETAUTOHIDEBAR = 7;
    m.view.setUint32(0x100, 36, true);
    for (const message of [ABM_NEW, ABM_GETSTATE, ABM_GETTASKBARPOS, ABM_GETAUTOHIDEBAR])
    {
        assert.equal(m.shell.SHAppBarMessage.handler([message, 0x100]), 0, `${message}`);
    }
    assert.deepEqual([...m.memory.subarray(0x104, 0x124)], Array(32).fill(0xaa),
        'the record is not written');
    assert.equal(m.diverged.length, 1, 'said once');
    assert.equal(m.shell.SHAppBarMessage.argBytes, 8);
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
