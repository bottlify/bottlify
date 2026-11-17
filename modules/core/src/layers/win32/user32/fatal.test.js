/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFatalBox } from './fatal.js';

test('a box reports a crash after a fault was reported, or in the system\'s fatal style', ()=>{
    // The .NET runtime's unhandled-exception box: OKCANCEL, ICONEXCLAMATION,
    // TASKMODAL, DEFAULT_DESKTOP_ONLY - after its handler called ReportFault.
    assert.equal(isFatalBox(0x22031, true), true, 'after ReportFault, whatever its icon');
    assert.equal(isFatalBox(0x22031, false), false, 'the same box with no fault is not');
    // The C runtime's "Runtime Error!": OK, ICONHAND, TASKMODAL, SETFOREGROUND.
    assert.equal(isFatalBox(0x12010, false), true);
    // The system's hard-error box: ICONHAND, SYSTEMMODAL.
    assert.equal(isFatalBox(0x1010, false), true);
    // A program's own error box, modal to its window: it goes on afterwards.
    assert.equal(isFatalBox(0x10, false), false);
    // A question or a warning modal to the task is no crash.
    assert.equal(isFatalBox(0x2024, false), false);
    assert.equal(isFatalBox(0x2030, false), false);
});
