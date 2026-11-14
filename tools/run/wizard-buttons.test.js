/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isButtonClass, label } from './wizard-buttons.mjs';

test('the system class and a framework\'s superclass of it are both buttons', ()=>{
    for (const name of ['Button', 'BUTTON', 'TButton', 'TNewButton', 'TBitBtn', 'TNewRadioButton'])
    {
        assert.equal(isButtonClass(name), true, name);
    }
    for (const name of ['Static', 'TNewStaticText', 'TPage', 'Edit', 'TButtonPanel'])
    {
        assert.equal(isButtonClass(name), false, name);
    }
});

test('a label is read without its mnemonic and in any case', ()=>{
    assert.equal(label('&Next >'), 'next >');
    assert.equal(label('I &accept the agreement'), 'i accept the agreement');
});
