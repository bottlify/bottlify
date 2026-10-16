/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleCursor } from './cursor.js';

test('an exclusive DirectInput mouse hides the system cursor and not a device\'s', ()=>{
    // Titan Quest holds the mouse exclusively and shows its cursor through
    // IDirect3DDevice9::ShowCursor: on Windows it is on screen throughout.
    const system = { shown: true, name: 'arrow' };
    const device = { shown: true, name: 'sword' };
    assert.equal(visibleCursor(system, null, false), system);
    assert.equal(visibleCursor(system, null, true).shown, false, 'the system cursor, held');
    assert.equal(visibleCursor(system, device, true), device, 'the device cursor, held or not');
});

test('a device that set its cursor and hides it leaves no cursor, not the system arrow', ()=>{
    // Hiding the device cursor is SetCursor(NULL) on Windows: Titan Quest
    // hides it while its menu builds, and the arrow must not show through.
    const hidden = visibleCursor({ shown: true, name: 'arrow' }, { shown: false, name: 'sword' },
        false);
    assert.equal(hidden.shown, false);
});
