/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steam client a signed-in run has, as steam_api finds it before it
 * loads the client: HKCU\Software\Valve\Steam\ActiveProcess names a pid, and
 * OpenProcess on it gives a process still running. A program of either width
 * reads the pid, opens the process and asks its exit code; it exits with the
 * step that failed, 0 when the client is there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createRunRegistry } from './layers/win32/module.js';
import { announceSteamClient } from './layers/win32/steamclient/functions.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

const EXIT = 0x100;
const STILL_ACTIVE = 259;
const IMPORTS = { 'ADVAPI32.dll': ['RegOpenKeyExA', 'RegQueryValueExA'],
    'KERNEL32.dll': ['OpenProcess', 'GetExitCodeProcess', 'ExitProcess'] };
const DATA = { path: ascii('Software\\Valve\\Steam\\ActiveProcess'), pid: ascii('pid') };

const wide = buildExe({
    bits: 64, codeSize: 0x200, imports: IMPORTS, data: DATA,
    code: ({ iat, at, code })=>{
        /** @type {number[]} */
        const bytes = [];
        /** @param {number[]} op @param {number} to */
        const rip = (op, to)=>bytes.push(...op, ...u32(to - (code(bytes.length) + op.length + 4)));
        const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
        const fail = (/** @type {number} */ step, when = 0x85)=>{
            bytes.push(0xb9, ...u32(step));
            rip([0x0f, when], code(EXIT));
        };
        bytes.push(0x48, 0x83, 0xec, 0x58); // sub rsp, 0x58
        // RegOpenKeyExA(HKEY_CURRENT_USER, path, 0, KEY_READ, [rsp+0x40])
        bytes.push(0x48, 0xc7, 0xc1, ...u32(0x80000001));
        rip([0x48, 0x8d, 0x15], at('path'));
        bytes.push(0x45, 0x31, 0xc0, 0x41, 0xb9, ...u32(0x20019));
        bytes.push(0x48, 0x8d, 0x44, 0x24, 0x40, 0x48, 0x89, 0x44, 0x24, 0x20);
        call('RegOpenKeyExA');
        bytes.push(0x85, 0xc0); fail(1);
        // RegQueryValueExA(key, "pid", NULL, NULL, [rsp+0x48], [rsp+0x50] = 4)
        bytes.push(0x48, 0x8b, 0x4c, 0x24, 0x40);
        rip([0x48, 0x8d, 0x15], at('pid'));
        bytes.push(0x45, 0x31, 0xc0, 0x45, 0x31, 0xc9);
        bytes.push(0x48, 0x8d, 0x44, 0x24, 0x48, 0x48, 0x89, 0x44, 0x24, 0x20);
        bytes.push(0x48, 0x8d, 0x44, 0x24, 0x50, 0xc7, 0x00, ...u32(4));
        bytes.push(0x48, 0x89, 0x44, 0x24, 0x28);
        call('RegQueryValueExA');
        bytes.push(0x85, 0xc0); fail(2);
        // OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pid)
        bytes.push(0xb9, ...u32(0x400), 0x31, 0xd2, 0x44, 0x8b, 0x44, 0x24, 0x48);
        call('OpenProcess');
        bytes.push(0x48, 0x85, 0xc0); fail(3, 0x84);
        // GetExitCodeProcess(process, [rsp+0x50]) == STILL_ACTIVE
        bytes.push(0x48, 0x89, 0xc1, 0x48, 0x8d, 0x54, 0x24, 0x50);
        call('GetExitCodeProcess');
        bytes.push(0x85, 0xc0); fail(4, 0x84);
        bytes.push(0x81, 0x7c, 0x24, 0x50, ...u32(STILL_ACTIVE)); fail(5);
        bytes.push(0xb9, ...u32(0));
        assert.ok(bytes.length <= EXIT);
        bytes.push(...new Array(EXIT - bytes.length).fill(0x90));
        call('ExitProcess');
        return bytes;
    },
});

const narrow = buildExe({
    codeSize: 0x200, imports: IMPORTS, data: DATA,
    code: ({ iat, at, code })=>{
        /** @type {number[]} */
        const bytes = [];
        const call = (/** @type {string} */ name)=>bytes.push(0xff, 0x15, ...u32(iat(name)));
        const fail = (/** @type {number} */ step, when = 0x85)=>{
            bytes.push(0xb9, ...u32(step), 0x0f, when);
            bytes.push(...u32(code(EXIT) - (code(bytes.length) + 4)));
        };
        bytes.push(0x83, 0xec, 0x20, 0x89, 0xe5); // sub esp, 32; mov ebp, esp
        // RegOpenKeyExA(HKEY_CURRENT_USER, path, 0, KEY_READ, &[ebp])
        bytes.push(0x8d, 0x45, 0x00, 0x50, 0x68, ...u32(0x20019), 0x6a, 0x00);
        bytes.push(0x68, ...u32(at('path')), 0x68, ...u32(0x80000001));
        call('RegOpenKeyExA');
        bytes.push(0x85, 0xc0); fail(1);
        // RegQueryValueExA([ebp], "pid", NULL, NULL, &[ebp+4], &[ebp+8] = 4)
        bytes.push(0xc7, 0x45, 0x08, ...u32(4), 0x8d, 0x45, 0x08, 0x50, 0x8d, 0x45, 0x04, 0x50);
        bytes.push(0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('pid')), 0xff, 0x75, 0x00);
        call('RegQueryValueExA');
        bytes.push(0x85, 0xc0); fail(2);
        // OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, [ebp+4])
        bytes.push(0xff, 0x75, 0x04, 0x6a, 0x00, 0x68, ...u32(0x400));
        call('OpenProcess');
        bytes.push(0x85, 0xc0); fail(3, 0x84);
        // GetExitCodeProcess(process, &[ebp+12]) == STILL_ACTIVE
        bytes.push(0x8d, 0x4d, 0x0c, 0x51, 0x50);
        call('GetExitCodeProcess');
        bytes.push(0x85, 0xc0); fail(4, 0x84);
        bytes.push(0x81, 0x7d, 0x0c, ...u32(STILL_ACTIVE)); fail(5);
        bytes.push(0xb9, ...u32(0));
        assert.ok(bytes.length <= EXIT);
        bytes.push(...new Array(EXIT - bytes.length).fill(0x90));
        bytes.push(0x51); // push ecx
        call('ExitProcess');
        return bytes;
    },
});

const ACCOUNT = { steamId: '76561197960287930', accountName: 'test', apps: [480], appId: 480 };

/**
 * A saved session whose registry names a Steam client a past run had: a pid
 * no process of this run has.
 */
function staleSession(){
    const hive = createRunRegistry({});
    announceSteamClient(hive, { pid: 0x7770, account: ACCOUNT });
    return { storage: { load: async()=>({ registry: hive.toJSON() }) } };
}

/** @param {Uint8Array} executable @param {object} where */
async function run(executable, where){
    const app = await createApp({ executable, ...where, win32: { steam: ACCOUNT } });
    try
    {
        return await app.run({ timeoutMs: 100000 });
    }
    finally
    {
        app.dispose();
    }
}

// On the page's thread, and in a worker of its own beside the run's system
// half, where the launcher runs a program: the run's registry and directory
// of processes are the system half's there, not the program's.
for (const [where, options] of /** @type {[string, object][]} */ ([
    ['on the run\'s thread', {}],
    ['in a worker of its own', { concurrency: 2 }],
    ['on the run\'s thread, over a saved session', staleSession()],
    ['in a worker of its own, over a saved session', { concurrency: 2, ...staleSession() }],
]))
{
    for (const [bits, executable] of /** @type {[number, Uint8Array][]} */ ([[64, wide],
        [32, narrow]]))
    {
        test(`a ${bits}-bit program ${where} opens the Steam client the registry names, running`,
            { timeout: 120000 }, async()=>{
                assert.equal(await run(executable, options), 0);
            });
    }
}
