/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOWS_CHOICES, windowsChoice } from './windows.js';
import { WINDOWS_VERSIONS } from '../../core/src/layers/win32/kernel32/versions.js';

test('the choices are the engine\'s own four', ()=>{
    // A name this side accepted and the engine refused would make a bottle
    // that cannot start; one the engine accepts and this side refused, a
    // bottle that cannot be made.
    assert.deepEqual([...WINDOWS_CHOICES], Object.keys(WINDOWS_VERSIONS));
});

test('absent is the engine\'s default, and anything but the four is refused by name', ()=>{
    assert.equal(windowsChoice(undefined), undefined);
    assert.equal(windowsChoice(null), undefined, 'a manifest that wrote null named nothing');
    for (const name of WINDOWS_CHOICES)
    {
        assert.equal(windowsChoice(name), name);
    }
    for (const wrong of ['win98', 'WinXP', 'xp', '', 7])
    {
        assert.throws(()=>windowsChoice(wrong),
            /unknown Windows version .*: the choices are win2000, winxp, win7, win10/,
            JSON.stringify(wrong));
    }
});
