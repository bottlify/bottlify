/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A host call whose guest callback waits in the kernel: the thread is parked
 * on a kernel object, not on the host, and a machine whose threads all wait
 * so sleeps until one is woken. The ngen service (mscorsvw.exe) waits so,
 * its ServiceMain run inside StartServiceCtrlDispatcherW on events another
 * process sets: counted as a call outstanding, it turned without sleeping in
 * a worker of its own, a core spent on nothing beside the compiler.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/** How long the child sleeps before it sets the event, in milliseconds. */
const SLEEP_MS = 600;

/**
 * A parent that names an event, starts a child and waits for the event in
 * the callback EnumDisplayMonitors makes, then for the child, and exits with
 * 7; and the child, which sleeps, sets the event by name and exits.
 */
function buildPair(){
    const parent = buildExe({
        imports: {
            'KERNEL32.dll': ['CreateEventA', 'CreateProcessA', 'WaitForSingleObject',
                'ExitProcess'],
            'USER32.dll': ['EnumDisplayMonitors'],
        },
        data: {
            name: ascii('Ready'),
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            event: u32(0),
        },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {number} callback */
            const main = callback=>[
                // event = CreateEventA(NULL, TRUE, FALSE, "Ready")
                0x68, ...u32(at('name')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
                ...call('CreateEventA'), 0xa3, ...u32(at('event')),
                // CreateProcessA(0, command, ..., &startup, &info)
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                ...call('CreateProcessA'),
                // EnumDisplayMonitors(0, 0, callback, 0): the callback waits
                0x6a, 0, 0x68, ...u32(callback), 0x6a, 0, 0x6a, 0,
                ...call('EnumDisplayMonitors'),
                // WaitForSingleObject(info.hProcess, INFINITE); ExitProcess(7)
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')), ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ];
            const callback = [
                // WaitForSingleObject(event, INFINITE); return TRUE
                0x6a, 0xff, 0xff, 0x35, ...u32(at('event')), ...call('WaitForSingleObject'),
                0xb8, ...u32(1), 0xc2, 0x10, 0x00,
            ];
            return [...main(code(main(0).length)), ...callback];
        },
    });
    const child = buildExe({
        imports: { 'KERNEL32.dll': ['Sleep', 'OpenEventA', 'SetEvent', 'ExitProcess'] },
        data: { name: ascii('Ready') },
        code: ({ iat, at })=>[
            // Sleep(SLEEP_MS); SetEvent(OpenEventA(EVENT_ALL_ACCESS, FALSE, "Ready"))
            0x68, ...u32(SLEEP_MS), 0xff, 0x15, ...u32(iat('Sleep')),
            0x68, ...u32(at('name')), 0x6a, 0, 0x68, ...u32(0x1f0003),
            0xff, 0x15, ...u32(iat('OpenEventA')),
            0x50, 0xff, 0x15, ...u32(iat('SetEvent')),
            0x6a, 5, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    return { parent, child };
}

test('a process whose thread waits in the kernel inside a host call\'s callback, for an event'
    + ' a process in another worker sets, sleeps while it waits', { timeout: 120_000 }, async t=>{
    const { parent, child } = buildPair();
    const app = await createApp({
        executable: parent,
        imagePath: 'C:\\App\\parent.exe',
        concurrency: 2,
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
    });
    t.after(()=>app.dispose());
    assert.equal((await app.run({ timeoutMs: 120_000 })) >>> 0, 7,
        'woken in the callback by the child\'s event, then by its exit');
    // The run loop's turns, guest work or none, as its phase profile counts
    // them: the kernel counts only the turns its threads ran.
    const phases = app.diagnostics().find((/** @type {any} */ entry)=>entry.name === 'log')
        ?.metrics?.topPhases ?? [];
    const turn = phases.map((/** @type {string} */ row)=>/^turn host x(\d+) /.exec(row))
        .find(Boolean);
    assert.ok(turn, `the parent's turns are counted: ${phases.join('; ')}`);
    // Asleep, it turns a few times for each wake of its pacing (every 50 ms
    // at most); a turn with nothing ready, round the event loop and back,
    // comes hundreds of thousands of times a second.
    assert.ok(Number(turn[1]) < 1000, `the parent turned ${turn[1]} times while it waited`);
});
