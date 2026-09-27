/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describeDialog, terminalAnswerer } from './terminal.js';

/** @type {import('./terminal.js').UnattendedDialog} */
const DIALOG = {
    kind: 'messagebox',
    title: 'Component Failure',
    text: 'Continue the installation?',
    buttons: [{ id: 6, label: 'Yes', default: false }, { id: 7, label: 'No', default: true }],
};

test('a dialog is printed with its buttons numbered and the default marked', ()=>{
    assert.equal(describeDialog(DIALOG),
        'Component Failure\nContinue the installation?\n1) Yes  2) No (default)');
});

test('at a terminal the number typed picks the button, and an empty line the default', async()=>{
    for (const [typed, id] of /** @type {[string, number][]} */ ([['1', 6], ['', 7], ['9', 7]]))
    {
        const input = Object.assign(new PassThrough(), { isTTY: true });
        const output = new PassThrough();
        let shown = '';
        output.on('data', chunk=>{
            shown += chunk;
        });
        const answer = terminalAnswerer({ input, output })(DIALOG);
        input.write(`${typed}\n`);
        assert.equal(await answer, id, `typed "${typed}"`);
        assert.match(shown, /1\) Yes {2}2\) No \(default\)/);
    }
});

test('with no terminal, or an answer given up front, nobody is asked', ()=>{
    const piped = Object.assign(new PassThrough(), { isTTY: false });
    const output = new PassThrough();
    assert.equal(terminalAnswerer({ input: piped, output })(DIALOG), 7, 'piped: the default');
    assert.equal(terminalAnswerer({ input: piped, output, choice: 'default' })(DIALOG), 7);
    assert.equal(terminalAnswerer({ input: piped, output, choice: 1 })(DIALOG), 6, '--answer 1');
});
