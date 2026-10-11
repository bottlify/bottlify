/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GPU_PROFILES, describeAdapter, profileCaps } from './adapter.js';
import { VIDEO_ADAPTER_NAME } from '../../win32/devices.js';

test('the adapter is shown with the browser\'s vendor, or with its profile\'s card', ()=>{
    assert.deepEqual(describeAdapter({ vendor: 'Apple' }),
        { vendorId: 0x106b, deviceId: 0, description: VIDEO_ADAPTER_NAME });
    assert.deepEqual(describeAdapter(null),
        { vendorId: 0, deviceId: 0, description: VIDEO_ADAPTER_NAME });
    // A profile's card, whatever the browser's is; the name stays the machine's own.
    assert.deepEqual(describeAdapter({ vendor: 'apple', profile: 'sm2' }),
        { vendorId: 0x1002, deviceId: 0x4e48, description: VIDEO_ADAPTER_NAME });
    assert.equal(describeAdapter({ vendor: 'intel', profile: 'other' }).vendorId, 0x8086,
        'a profile it does not know is no profile');
});

test('a profile brings its card\'s shader versions, model by model', ()=>{
    for (const [name, major] of /** @type {[string, number][]} */ ([['sm1', 1], ['sm2', 2],
        ['sm3', 3], ['sm4', 3]]))
    {
        const caps = profileCaps({ profile: name });
        assert.equal(caps.vertexShaderVersion?.major, major, name);
        assert.equal(caps.pixelShaderVersion?.major, major, name);
    }
    assert.deepEqual(profileCaps({ profile: 'sm1' }).pixelShaderVersion, { major: 1, minor: 3 });
    assert.deepEqual(profileCaps({ vendor: 'apple' }), {});
    assert.equal(Object.keys(GPU_PROFILES).join(), 'sm1,sm2,sm3,sm4');
});
