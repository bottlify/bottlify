/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSecondNames, MSVCRT_SECOND_NAMES, UCRTBASE_SECOND_NAMES } from './second-names.js';

/** @param {number} argBytes */
const entry = argBytes=>({ convention: 'cdecl', argBytes, handler: ()=>0 });

test('a second name is the entry it names, an _l form with the locale after the rest', ()=>{
    /** @type {Record<string, any>} */
    const table = { strtol: entry(12), _mbsicmp: entry(8), tolower: entry(4), _tolower: entry(4),
        _fseeki64: entry(16), logb: entry(8), malloc: entry(4) };
    addSecondNames(table, ['_o_malloc', '_strtol_l', '_o__strtol_l', '_mbsicmp_l', '_tolower_l',
        '_fseeki64_nolock', 'logbl', '_strtoull_l', '_o_free']);

    assert.equal(table._o_malloc, table.malloc, 'one entry, so either name reaches one state');
    assert.equal(table._fseeki64_nolock, table._fseeki64);
    assert.equal(table.logbl, table.logb, 'long double is the double');
    assert.equal(table._strtol_l.handler, table.strtol.handler);
    assert.equal(table._strtol_l.argBytes, 16, 'the locale is one argument more');
    assert.equal(table._o__strtol_l, table._strtol_l, 'a name over a second name');
    assert.equal(table._mbsicmp_l.argBytes, 12);
    assert.equal(table._tolower_l.handler, table.tolower.handler,
        '_tolower_l is tolower\'s, which checks the character, not _tolower\'s');
    assert.equal(Object.hasOwn(table, '_strtoull_l'), false, 'no strtoull, no second name');
    assert.equal(Object.hasOwn(table, '_o_free'), false);
});

test('an entry the table has already keeps its own, and printf\'s locale forms are not here', ()=>{
    const own = entry(8);
    /** @type {Record<string, any>} */
    const table = { strtol: entry(12), _strtol_l: own };
    addSecondNames(table, ['_strtol_l']);
    assert.equal(table._strtol_l, own);
    for (const names of [UCRTBASE_SECOND_NAMES, MSVCRT_SECOND_NAMES])
    {
        assert.deepEqual(names.filter(name=>/printf|scanf/.test(name) && !name.startsWith('_o_')),
            [], 'their locale comes before the variadic arguments');
    }
});
