/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { CLSID_DRAG_DROP_HELPER, registerDragDropHelperClass } from './dragdrop.js';

const IID_IDROP_TARGET_HELPER = '{4657278B-411B-11D2-839A-00C04FD918D0}';
const IID_IDRAG_SOURCE_HELPER = '{DE5BF786-477A-11D2-839D-00C04FD918D0}';
const IID_IDRAG_SOURCE_HELPER2 = '{83E07D0D-0C5F-4163-BF1A-60B274051E40}';

test('one helper object is the drop target\'s and both drag sources\' helper', async()=>{
    const registry = createComRegistry();
    registerDragDropHelperClass(registry);
    const object = /** @type {any} */ (registry.create(CLSID_DRAG_DROP_HELPER));
    assert.ok(object);
    const target = object.queryInterface(IID_IDROP_TARGET_HELPER);
    assert.deepEqual(target.methods.slice(3).map((/** @type {any} */ method)=>
        [method.name, method.argBytes]), [['DragEnter', 20], ['DragLeave', 4],
        ['DragOver', 12], ['Drop', 16], ['Show', 8]]);
    for (const method of target.methods.slice(3))
    {
        assert.equal(await method.invoke(object, [0, 0, 0, 0]), 0, `${method.name} is taken`);
    }
    assert.deepEqual(object.queryInterface(IID_IDRAG_SOURCE_HELPER).methods.slice(3)
        .map((/** @type {any} */ method)=>method.name),
    ['InitializeFromBitmap', 'InitializeFromWindow']);
    assert.equal(object.queryInterface(IID_IDRAG_SOURCE_HELPER2).methods.at(-1).name, 'SetFlags');
});
