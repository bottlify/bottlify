/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputRecipient } from './app.js';
import { createWindowManager } from './layers/win32/user32/manager.js';

/**
 * A dialog of process 0x100 in the middle of a screen with nothing else on it:
 * the desktop all around.
 */
function dialogOnTheDesktop(){
    const manager = createWindowManager();
    const rect = { left: 300, top: 160, right: 700, bottom: 400 };
    manager.publish({
        hwnd: 0x10, processId: 0x100, threadId: 0x104, parent: 0, owner: 0, className: '#32770',
        title: 'Select Renderer', style: 0x10000000, exStyle: 0, rect, client: rect,
        visible: true, enabled: true, minimized: false, maximized: false, topmost: false,
        region: null,
    });
    manager.setForeground(0x10);
    return manager;
}

test('motion over the desktop still reaches the program whose cursor it moves', ()=>{
    // A locked pointer's motion took the cursor onto the desktop; dropped there,
    // the cursor never left it and the dialog had no mouse at all.
    const manager = dialogOnTheDesktop();
    assert.deepEqual(inputRecipient(manager, { kind: 'pointerMove', x: 50, y: 50 }),
        { target: null, dropped: false }, 'motion: never dropped');
    assert.deepEqual(inputRecipient(manager, { kind: 'pointerButton', button: 'left', down: true }),
        { target: null, dropped: true }, 'a press over the desktop goes to nobody, as on Windows');
});

test('a locked pointer is placed where the cursor is, not where the page last named', ()=>{
    // The page last named the desktop -- a click there -- and then sent motion
    // alone, which took the cursor over the dialog.
    const manager = dialogOnTheDesktop();
    inputRecipient(manager, { kind: 'pointerButton', button: 'left', down: true, x: 50, y: 50 });
    const cursor = { x: 500, y: 300 };
    assert.deepEqual(
        inputRecipient(manager, { kind: 'pointerButton', button: 'left', down: true }, cursor),
        { target: 0x100, dropped: false }, 'the press goes to the dialog under the cursor');
    assert.deepEqual(inputRecipient(manager, { kind: 'pointerMove', dx: 4, dy: 0 }, cursor),
        { target: 0x100, dropped: false });
    assert.deepEqual(inputRecipient(manager, { kind: 'key', code: 'Enter', down: true }, cursor),
        { target: 0x100, dropped: false }, 'the keyboard still goes by the focus');
});

test('the routed input reads the cursor a locked pointer points with', async t=>{
    // The routing placed a locked pointer's press at `cursor()`, which the
    // machine's input did not have: every such press went by the last place
    // the page named.
    const { createApp } = await import('./app.js');
    const { buildExe } = await import('../../../tools/make-pe.mjs');
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x10,
        code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15,
            ...[0, 8, 16, 24].map(shift=>(iat('ExitProcess') >>> shift) & 0xff)],
    });
    const app = await createApp({ executable, imagePath: 'C:\\App\\Still.exe' });
    t.after(()=>app.dispose());
    assert.equal(typeof app.input.cursor, 'function');
    const from = /** @type {{ x: number, y: number }} */ (app.input.cursor());
    app.input.send({ kind: 'pointerMove', dx: 7, dy: 3 });
    assert.deepEqual(app.input.cursor(), { x: from.x + 7, y: from.y + 3 });
});
