/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpoolerFunctions } from './functions.js';

test('with no printer installed, opening one fails by name and properties are refused', ()=>{
    /** @type {number[]} */
    const errors = [];
    const fns = createSpoolerFunctions({ setLastError: code=>errors.push(code) });

    assert.equal(fns.OpenPrinterA.handler(), 0);
    assert.deepEqual(errors, [1801], 'ERROR_INVALID_PRINTER_NAME');
    assert.equal(fns.DocumentPropertiesA.handler(), -1);
    assert.equal(fns.ClosePrinter.handler(), 0);

    assert.equal(fns.OpenPrinterA.argBytes, 12);
    assert.equal(fns.ClosePrinter.argBytes, 4);
    assert.equal(fns.DocumentPropertiesA.argBytes, 24);
});
