/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A message box a program has subclassed ends on its button. A framework's
 * CBT hook replaces the procedure of every window its thread makes -- the box
 * too -- with one of its own that hands each message on through
 * CallWindowProc, so the button's WM_COMMAND reaches the box's own procedure,
 * and EndDialog, from inside a call the program made. The program here does
 * the same: its hook subclasses the first window made, a timer posts the box
 * IDOK, and MessageBox's answer is the exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WH_CBT = 5;
const HCBT_CREATEWND = 3;
const WM_COMMAND = 0x111;
const IDOK = 1;

function buildProgram(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetCurrentThreadId', 'ExitProcess'],
            'USER32.dll': ['SetWindowsHookExA', 'SetTimer', 'MessageBoxA', 'SetWindowLongA',
                'CallWindowProcA', 'PostMessageA'],
        },
        data: {
            box: [0, 0, 0, 0], old: [0, 0, 0, 0],
            text: [...Buffer.from('Ready?\0')], caption: [...Buffer.from('Box\0')],
        },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {number} hook @param {number} timer */
            const main = (hook, timer)=>[
                ...call('GetCurrentThreadId'),
                0x50, 0x6a, 0x00, 0x68, ...u32(hook), 0x6a, WH_CBT, //  thread, module, hook
                ...call('SetWindowsHookExA'),
                0x68, ...u32(timer), 0x6a, 50, 0x6a, 0x01, 0x6a, 0x00, // proc, 50 ms, id, window
                ...call('SetTimer'),
                0x6a, 0x00, 0x68, ...u32(at('caption')), 0x68, ...u32(at('text')), 0x6a, 0x00,
                ...call('MessageBoxA'),
                0x50, ...call('ExitProcess'), //                 the answer
            ];
            // The hook: the first window made gets the program's procedure.
            /** @param {number} subclass */
            const hook = subclass=>[
                0x83, 0x7c, 0x24, 0x04, HCBT_CREATEWND, //       cmp dword [esp+4], HCBT_CREATEWND
                0x75, 0x25, //                                   jne done
                0x83, 0x3d, ...u32(at('box')), 0x00, //          cmp dword [box], 0
                0x75, 0x1c, //                                   jne done
                0x8b, 0x44, 0x24, 0x08, //                       mov eax, [esp+8]
                0xa3, ...u32(at('box')), //                      mov [box], eax
                0x68, ...u32(subclass), 0x6a, 0xfc, 0x50, //     procedure, GWL_WNDPROC, window
                ...call('SetWindowLongA'),
                0xa3, ...u32(at('old')), //                      mov [old], eax
                0x31, 0xc0, //                                   done: xor eax, eax
                0xc2, 0x0c, 0x00, //                             ret 12
            ];
            // Every message handed on to the procedure it replaced.
            const subclass = [
                0xff, 0x74, 0x24, 0x10, 0xff, 0x74, 0x24, 0x10, // lParam, wParam
                0xff, 0x74, 0x24, 0x10, 0xff, 0x74, 0x24, 0x10, // message, window
                0xff, 0x35, ...u32(at('old')),
                ...call('CallWindowProcA'),
                0xc2, 0x10, 0x00, //                             ret 16
            ];
            const timer = [
                0x6a, 0x00, 0x6a, IDOK, 0x68, ...u32(WM_COMMAND), // lParam, IDOK, WM_COMMAND
                0xff, 0x35, ...u32(at('box')),
                ...call('PostMessageA'),
                0xc2, 0x10, 0x00, //                             ret 16
            ];
            const mainLength = main(0, 0).length;
            const hookAt = mainLength;
            const subclassAt = hookAt + hook(0).length;
            const timerAt = subclassAt + subclass.length;
            return [...main(code(hookAt), code(timerAt)), ...hook(code(subclassAt)), ...subclass,
                ...timer];
        },
    });
}

test('a message box a hook subclassed ends on its button with that button\'s answer',
    { timeout: 60000 }, async t=>{
        const app = await createApp({
            executable: buildProgram(),
            imagePath: 'C:\\App\\Box.exe',
            engine: 'cork',
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 20000 }), IDOK);
    });
