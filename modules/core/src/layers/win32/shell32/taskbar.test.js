/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { CLSID_TASKBAR_LIST, registerTaskbarListClass } from './taskbar.js';

const IID_ITASKBAR_LIST = '{56FDF342-FD6D-11D0-958A-006097C9A090}';
const IID_ITASKBAR_LIST2 = '{602D4995-B13A-429B-A66E-1935E44F4317}';
const IID_ITASKBAR_LIST3 = '{EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF}';

test('the taskbar list is made, takes every call of XP\'s two interfaces, and has no later one',
    async()=>{
        const registry = createComRegistry();
        registerTaskbarListClass(registry);
        const object = /** @type {any} */ (registry.create(CLSID_TASKBAR_LIST));
        assert.ok(object, 'CoCreateInstance(CLSID_TaskbarList) finds it');
        const list = object.queryInterface(IID_ITASKBAR_LIST);
        assert.deepEqual(list.methods.slice(3).map((/** @type {any} */ method)=>
            [method.name, method.argBytes]), [['HrInit', 4], ['AddTab', 8], ['DeleteTab', 8],
            ['ActivateTab', 8], ['SetActiveAlt', 8]]);
        const list2 = object.queryInterface(IID_ITASKBAR_LIST2);
        assert.deepEqual(list2.methods.slice(3).map((/** @type {any} */ method)=>method.name),
            ['HrInit', 'AddTab', 'DeleteTab', 'ActivateTab', 'SetActiveAlt',
                'MarkFullscreenWindow']);
        assert.equal(list2.methods.at(-1).argBytes, 12);
        for (const method of list2.methods.slice(3))
        {
            assert.equal(await method.invoke(object, [0x10010, 1]), 0, `${method.name} is taken`);
        }
        assert.ok(!object.queryInterface(IID_ITASKBAR_LIST3),
            'ITaskbarList3 is Windows 7\'s: XP\'s shell answers E_NOINTERFACE');
    });
