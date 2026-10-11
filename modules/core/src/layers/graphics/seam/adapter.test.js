/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESENTED_CARDS, describeAdapter, presentedCaps } from './adapter.js';
import { VIDEO_ADAPTER_NAME } from '../../win32/devices.js';

test('an adapter is told of by the browser\'s vendor, or as the card it is presented as', ()=>{
    assert.deepEqual(describeAdapter({ vendor: 'Apple' }),
        { vendorId: 0x106b, deviceId: 0, description: VIDEO_ADAPTER_NAME });
    assert.deepEqual(describeAdapter(null),
        { vendorId: 0, deviceId: 0, description: VIDEO_ADAPTER_NAME });
    // Presented as a card a program's database knows, whatever the browser's is;
    // the name stays the machine's own.
    assert.deepEqual(describeAdapter({ vendor: 'apple', presentAs: 'nvidia' }), {
        vendorId: PRESENTED_CARDS.nvidia.vendorId, deviceId: PRESENTED_CARDS.nvidia.deviceId,
        description: VIDEO_ADAPTER_NAME });
    // And its shaders, which a program that knows the card expects of it.
    assert.deepEqual(presentedCaps({ presentAs: 'amd' }).pixelShaderVersion,
        { major: 2, minor: 0 });
    assert.deepEqual(presentedCaps({ vendor: 'apple' }), {});
    assert.equal(describeAdapter({ presentAs: 'amd' }).vendorId, 0x1002);
    assert.equal(describeAdapter({ vendor: 'intel', presentAs: 'other' }).vendorId, 0x8086,
        'a card it does not know is no card to present');
});
