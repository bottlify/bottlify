/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClassRegistry } from './classes.js';

const MAIN = 0x00400000;
const KERNEL32 = 0x7b800000;
const USER32 = 0x7e400000;
const CS_GLOBALCLASS = 0x4000;

const registry = ()=>createClassRegistry({ main: ()=>MAIN, user32: ()=>USER32,
    isSystem: name=>name.toLowerCase() === 'button' });

test('a local class is its module\'s, found by the module the call names', ()=>{
    // Wine's class test, test_instances.
    const classes = registry();
    const own = { name: '__test__', style: 0, instance: 0 };
    const kernel = { name: '__TEST__', style: 0, instance: KERNEL32 };
    assert.equal(classes.add(own), 0);
    assert.equal(own.instance, MAIN, 'none is the program\'s own module');
    assert.equal(classes.add({ name: '__test__', style: 0, instance: MAIN | 0x10 }), 1410,
        'the same module, by its high word');
    assert.equal(classes.add(kernel), 0, 'another module may have one of the name');

    assert.equal(classes.find('__test__', KERNEL32, 'create'), kernel);
    assert.equal(classes.find('__test__', MAIN, 'info'), own);
    assert.equal(classes.find('__test__', 0, 'create'), kernel, 'none takes the newest');
    assert.equal(classes.find('__test__', 0, 'info'), null, 'none is user32\'s, which has none');
    assert.equal(classes.find('__test__', 0, 'unregister'), own, 'none is the program\'s');
    assert.equal(classes.reportedInstance(kernel, KERNEL32), KERNEL32);
});

test('a global class is the process\'s, one of a name, and no system class\'s', ()=>{
    const classes = registry();
    const global = { name: 'Shared', style: CS_GLOBALCLASS, instance: MAIN };
    assert.equal(classes.add(global), 0);
    assert.equal(classes.add({ name: 'shared', style: 0, instance: KERNEL32 }), 1410,
        'not even a local one of the name');
    assert.equal(classes.find('SHARED', 0x12340000, 'create'), global, 'any module finds it');
    assert.equal(classes.reportedInstance(global, 0x12340000), 0x12340000,
        'reported as the module asked by');
    assert.equal(classes.reportedInstance(global, USER32), 0, 'user32\'s reads as none');
    global.style = 0;
    assert.equal(classes.find('shared', KERNEL32, 'create'), global,
        'global for good, whatever its style says later');

    assert.equal(classes.add({ name: 'BUTTON', style: CS_GLOBALCLASS, instance: MAIN }), 1410);
    assert.equal(classes.add({ name: 'BUTTON', style: 0, instance: MAIN }), 0,
        'a local class may share a system class\'s name');
    assert.equal(classes.add({ name: 'Mine', style: 0, instance: USER32 }), 87,
        'user32\'s module registers none');
});
