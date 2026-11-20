/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLazyLibraries } from './lazy-libraries.js';

test('a library is made when first read, once, and its names are known before', ()=>{
    const lazy = createLazyLibraries();
    let makes = 0;
    lazy.define('A.dll', ()=>{
        makes++;
        return { one: { argBytes: 0 } };
    });
    lazy.define('B.dll', ()=>({ two: {} }));
    assert.deepEqual(Object.keys(lazy.table), ['A.dll', 'B.dll']);
    assert.ok('A.dll' in lazy.table);
    assert.equal(makes, 0, 'names read nothing');
    assert.equal(lazy.table['A.dll'], lazy.table['A.dll']);
    assert.equal(makes, 1);
    assert.equal(lazy.made('B.dll'), false);
});

test('patches apply in order when the library is made, or at once when it was', ()=>{
    const lazy = createLazyLibraries();
    lazy.define('A.dll', ()=>({ shared: 1 }));
    lazy.define('B.dll', ()=>({}));
    /** @type {string[]} */
    const order = [];
    lazy.patch('B.dll', library=>{
        order.push('first');
        library.shared = lazy.table['A.dll'].shared;
    });
    lazy.patch('B.dll', ()=>order.push('second'));
    lazy.each((library, name)=>{
        library.seen = name;
    });
    assert.deepEqual(order, []);
    assert.equal(lazy.table['B.dll'].shared, 1);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(lazy.table['B.dll'].seen, 'B.dll');
    lazy.patch('B.dll', library=>{
        library.late = true;
    });
    assert.equal(lazy.table['B.dll'].late, true, 'a made library is patched at once');
});

test('a library that reads itself back while patched finds itself, not a second one', ()=>{
    const lazy = createLazyLibraries();
    lazy.define('A.dll', ()=>({ n: 1 }));
    lazy.patch('A.dll', library=>{
        library.self = lazy.table['A.dll'];
    });
    const a = lazy.table['A.dll'];
    assert.equal(a.self, a);
});

test('a table merged by its descriptors makes nothing, and forgets a library taken out', ()=>{
    const lazy = createLazyLibraries();
    let makes = 0;
    lazy.define('A.dll', ()=>{
        makes++;
        return {};
    });
    lazy.define('B.dll', ()=>({}));
    /** @type {Record<string, any>} */
    const all = {};
    Object.defineProperties(all, Object.getOwnPropertyDescriptors(lazy.table));
    Object.defineProperties(all, Object.getOwnPropertyDescriptors({ 'C.dll': { plain: true } }));
    assert.deepEqual(Object.keys(all), ['A.dll', 'B.dll', 'C.dll']);
    assert.equal(makes, 0);
    assert.equal(all['A.dll'], lazy.table['A.dll']);
    assert.equal(makes, 1);
    delete lazy.table['B.dll'];
    assert.equal(all['B.dll'], undefined);
    lazy.table['D.dll'] = { set: true };
    assert.deepEqual(lazy.table['D.dll'], { set: true });
});
