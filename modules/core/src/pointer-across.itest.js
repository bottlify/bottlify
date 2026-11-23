/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's pointer reaches a program's window as WM_MOUSEMOVE wherever the
 * program runs: on the run's thread, or in a worker of its own. A program in
 * a worker was handed the page's input without the canvas's size, and its
 * input never measured the canvas: its window was told of almost no motion
 * while DirectInput heard every step, so a game that draws its own cursor
 * from the window's messages showed none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const WM_KEYDOWN = 0x0100;
/** The bit the counting program marks its exit code with, apart from a launcher's. */
const PROGRAM_CODE = 0x10000;
const WM_MOUSEMOVE = 0x0200;

/**
 * A program with a visible window that counts the WM_MOUSEMOVE its window
 * procedure is given and, at the first WM_KEYDOWN, exits with that count
 * marked by PROGRAM_CODE.
 */
function buildPointerCounter(){
    const WNDPROC_OFFSET = 0x100;
    return buildExe({
        imports: {
            'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'GetMessageA',
                'DispatchMessageA', 'DefWindowProcA', 'PostQuitMessage'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        codeSize: 0x200,
        data: {
            className: [...'PointerCounter'].map(c=>c.charCodeAt(0)).concat(0),
            wndclass: new Array(40).fill(0), // WNDCLASSA
            msg: new Array(28).fill(0), //      MSG
            count: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            const pump = [0x68, ...u32(at('msg')), 0xff, 0x15, ...u32(iat('DispatchMessageA'))];
            const fetch = [0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('msg')),
                0xff, 0x15, ...u32(iat('GetMessageA')), 0x85, 0xc0]; // test eax, eax
            const main = [
                // wndclass.lpfnWndProc, wndclass.lpszClassName
                0xc7, 0x05, ...u32(at('wndclass') + 4), ...u32(code(WNDPROC_OFFSET)),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
                0x68, ...u32(at('wndclass')), 0xff, 0x15, ...u32(iat('RegisterClassA')),
                // CreateWindowExA(0, class, class, WS_VISIBLE | WS_POPUP, 0, 0, 640, 480,
                // 0, 0, 0, 0)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(480), 0x68, ...u32(640), 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(0x90000000),
                0x68, ...u32(at('className')), 0x68, ...u32(at('className')), 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateWindowExA')),
                // while (GetMessageA(&msg, 0, 0, 0) > 0) DispatchMessageA(&msg);
                ...fetch,
                0x7e, pump.length + 2, //   jle past the pump
                ...pump,
                0xeb, (256 - (fetch.length + 2 + pump.length + 2)) & 0xff,
                // ExitProcess(0x10000 | count): marked as this program's code
                0xa1, ...u32(at('count')), 0x0d, ...u32(PROGRAM_CODE), 0x50,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const moved = [
                0xff, 0x05, ...u32(at('count')), // inc dword [count]
                0x31, 0xc0, 0xc2, 0x10, 0x00, //    xor eax, eax; ret 16
            ];
            const keyed = [
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('PostQuitMessage')),
                0x31, 0xc0, 0xc2, 0x10, 0x00,
            ];
            const wndProc = [
                0x8b, 0x44, 0x24, 0x08, //          mov eax, [esp+8] (uMsg)
                0x3d, ...u32(WM_MOUSEMOVE), 0x75, moved.length, ...moved,
                0x3d, ...u32(WM_KEYDOWN), 0x75, keyed.length, ...keyed,
                0xff, 0x25, ...u32(iat('DefWindowProcA')), // the rest, its own arguments in place
            ];
            if (main.length > WNDPROC_OFFSET)
            {
                throw new Error('the body runs into the window procedure');
            }
            return [...main, ...new Array(WNDPROC_OFFSET - main.length).fill(0xcc), ...wndProc];
        },
    });
}

/** A launcher: starts C:\App\pointer.exe and exits at once, leaving the program on its own. */
function buildLauncher(){
    const startupSize = 68;
    return buildExe({
        codeSize: 0x100,
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'ExitProcess'] },
        data: { child: [...'C:\\App\\pointer.exe'].map(c=>c.charCodeAt(0)).concat(0),
            startup: [...u32(startupSize), ...new Array(startupSize - 4).fill(0)],
            info: new Array(16).fill(0) },
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
            0x68, ...u32(at('child')),
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** A canvas the page's input is attached to: only its size is read. */
const viewport = { width: 640, height: 480, clientWidth: 640, clientHeight: 480,
    getBoundingClientRect: ()=>({ left: 0, top: 0, width: 640, height: 480 }),
    addEventListener(){}, removeEventListener(){} };

for (const [where, options, launched] of /** @type {[string, any, boolean][]} */ ([
    ['on the run\'s thread', {}, false],
    ['in a worker of its own', { concurrency: 2 }, false],
    ['started by a launcher that is gone, in its place', {}, true],
    ['started by a launcher that is gone, in a worker of its own', { concurrency: 2 }, true],
]))
{
    test(`a program's window is told of the page's pointer moving, ${where}`,
        { timeout: 60000 }, async t=>{
            const app = await createApp(launched
                ? { executable: buildLauncher(), imagePath: 'C:\\App\\launcher.exe',
                    files: [{ path: 'C:\\App\\pointer.exe', bytes: buildPointerCounter() }],
                    ...options }
                : { executable: buildPointerCounter(), imagePath: 'C:\\App\\pointer.exe',
                    ...options });
            t.after(()=>app.dispose());
            app.input.attach?.(viewport, { listen: false });
            const run = app.run({ timeoutMs: 50000 });
            // Once its window stands: a motion a step at a time, each a while
            // apart for the program to take it, then a key.
            const shown = async()=>((await app.diagnostics()).find((/** @type {any} */ table)=>
                table.name === 'windows')?.metrics?.topLevel ?? []).some((/** @type {any} */ window)=>
                window.visible);
            for (let tries = 0; tries < 400 && !(await shown()); tries++)
            {
                await new Promise(resolve=>setTimeout(resolve, 50));
            }
            const steps = 20;
            for (let step = 1; step <= steps; step++)
            {
                app.input.send({ kind: 'pointerMove', x: 100 + step * 10, y: 100 + step * 5 });
                await new Promise(resolve=>setTimeout(resolve, 60));
            }
            app.input.send({ kind: 'key', code: 'KeyA', down: true });
            const code = await run;
            assert.equal(code & PROGRAM_CODE, PROGRAM_CODE, `the run's code is the program's: 0x${
                (code >>> 0).toString(16)}`);
            const told = code & 0xffff;
            assert.ok(told >= steps / 2, `the window was told of ${told} of ${steps} steps`);
        });
}
