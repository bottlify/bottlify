/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableSource } from './check-pointer-arguments.mjs';
import { POINTER_ARGUMENTS } from '../../modules/core/src/layers/win32/common/pointer-arguments.js';

test('the table is the signature comments\' address places, by every name a function has', ()=>{
    const source = tableSource();
    // A comment over a spec of its own; over a key whose body is made elsewhere;
    // over a helper that makes it; written once for both spellings.
    assert.match(source, /\n {4}lstrlenA: \[0\],/);
    assert.match(source, /\n {4}GetFileAttributesA: \[0\],/);
    assert.match(source, /\n {4}RegOpenKeyExA: \[1, 4\],/);
    assert.match(source, /\n {4}CreateFileW: \[0, 3\],/);
    // Written once for both forms at once (`EnumSystemLocalesA/W(...)`).
    assert.match(source, /\n {4}EnumSystemLocalesA: \[0\],/);
    assert.match(source, /\n {4}EnumSystemLocalesW: \[0\],/);
    assert.match(source, /\n {4}GetTextExtentExPointI: \[1, 4, 5, 6\],/);
    // A helper's comment, its signature after the prose.
    assert.match(source, /\n {4}EnumCalendarInfoW: \[0\],/);
    assert.doesNotMatch(source, /\n {4}'#/, 'no name by number: it is one library\'s');
    assert.deepEqual(POINTER_ARGUMENTS.PathIsUNCW, [0]);
    // A comment over a spec the file exports as both spellings, named by neither.
    assert.match(source, /\n {4}BuildTrusteeWithObjectsAndSidA: \[0, 1, 2, 3, 4\],/);
    assert.match(source, /\n {4}BuildTrusteeWithObjectsAndSidW: \[0, 1, 2, 3, 4\],/);
    // A REF... typedef is a const pointer: REFCLSID, REFIID.
    assert.match(source, /\n {4}CoCreateInstance: \[0, 1, 3, 4\],/);
});
