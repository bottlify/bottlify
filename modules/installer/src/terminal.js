/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Answering an unattended install's dialogs from a terminal.
 *
 * A silent install is run from a terminal, where nobody clicks: a dialog the
 * installer or one of its libraries raises anyway -- a requirements check, a
 * question the silent script cannot answer -- comes here instead of the
 * screen. At a terminal a person can still choose, so the dialog is printed
 * with its buttons numbered and the default marked, and the line typed picks
 * one; an empty line takes the default. Where nobody can -- output piped, a
 * CI job, or `--answer` given -- the choice is made without asking.
 *
 * Node-only (readline), and so not exported from the package's index, which
 * a browser loads.
 */

import { createInterface } from 'node:readline';

/**
 * @typedef {import('../../core/src/layers/win32/user32/dialogs.js').UnattendedDialog} UnattendedDialog
 */

/**
 * The dialog as a person reads it: title, text, then the buttons numbered.
 *
 * @param {UnattendedDialog} dialog
 * @returns {string}
 */
export function describeDialog(dialog){
    const buttons = dialog.buttons
        .map((button, index)=>`${index + 1}) ${button.label}${button.default ? ' (default)' : ''}`)
        .join('  ');
    return [dialog.title, dialog.text, buttons].filter(line=>line).join('\n');
}

/**
 * An answerer for createApp's `unattended.answer`.
 *
 * @param {Object} options
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} options.input
 * @param {NodeJS.WritableStream} options.output
 * @param {'default' | number} [options.choice]  Answer every dialog without
 *     asking: its default button, or the button with that number (the default
 *     when it has fewer).
 * @returns {(dialog: UnattendedDialog) => number | Promise<number>}
 */
export function terminalAnswerer({ input, output, choice }){
    /** @param {UnattendedDialog} dialog */
    const fallback = dialog=>dialog.buttons.find(button=>button.default)?.id
        ?? dialog.buttons[0]?.id ?? 1;
    /** @param {UnattendedDialog} dialog @param {string} typed */
    const pick = (dialog, typed)=>dialog.buttons[Number(typed) - 1]?.id ?? fallback(dialog);

    return dialog=>{
        if (choice === 'default')
        {
            return fallback(dialog);
        }
        if (typeof choice === 'number')
        {
            return pick(dialog, String(choice));
        }
        if (!input.isTTY)
        {
            return fallback(dialog);
        }
        return new Promise(resolve=>{
            const lines = createInterface({ input, output, terminal: false });
            output.write(`\n${describeDialog(dialog)}\n> `);
            lines.once('line', typed=>{
                lines.close();
                resolve(typed.trim() === '' ? fallback(dialog) : pick(dialog, typed.trim()));
            });
        });
    };
}
