/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXInput } from './xinput.js';

const ERROR_BAD_ARGUMENTS = 160;
const ERROR_DEVICE_NOT_CONNECTED = 1167;
const XUSER_MAX_COUNT = 4;
const XUSER_INDEX_ANY = 0xff;
const XINPUT_FLAG_GAMEPAD = 1;
const BATTERY_DEVTYPE_GAMEPAD = 0;

/** Somewhere a structure would be, which nothing here may write to. */
const OUT = 0x1000;
const OTHER = 0x2000;

/** @param {string} dll @param {string} name @param {number[]} args */
function call(dll, name, args){
    const entry = createXInput().libraries[dll]?.[name];
    assert.ok(entry, `${dll} exports ${name}`);
    assert.equal(entry.argBytes, args.length * 4, `${name} is stdcall over ${args.length}`);
    return entry.handler(args);
}

test('each library exports what its .spec does, and nothing it does not', ()=>{
    const { libraries } = createXInput();
    // Wine's xinput9_1_0.spec and xinput1_4.spec; its xinput.c checks on
    // Windows that 9.1.0 has no XInputEnable, keystrokes or battery, and that
    // 1.4 has no XInputGetDSoundAudioDeviceGuids.
    assert.deepEqual(Object.keys(libraries['XINPUT9_1_0.dll']).sort(), [
        'XInputGetCapabilities', 'XInputGetDSoundAudioDeviceGuids',
        'XInputGetState', 'XInputSetState',
    ]);
    assert.deepEqual(Object.keys(libraries['XINPUT1_4.dll']).sort(), [
        'XInputEnable', 'XInputGetAudioDeviceIds', 'XInputGetBatteryInformation',
        'XInputGetCapabilities', 'XInputGetCapabilitiesEx', 'XInputGetKeystroke',
        'XInputGetState', 'XInputGetStateEx', 'XInputSetState',
    ]);
});

test('xinput1_4 keeps the ordinals its .spec gives, the two taken by number among them', ()=>{
    // Wine's xinput1_4.spec numbers every export; its xinput.c takes
    // XInputGetStateEx by ordinal 100 where the name is absent.
    const { ordinals } = createXInput();
    assert.deepEqual(ordinals['XINPUT1_4.dll'], {
        2: 'XInputGetState',
        3: 'XInputSetState',
        4: 'XInputGetCapabilities',
        5: 'XInputEnable',
        7: 'XInputGetBatteryInformation',
        8: 'XInputGetKeystroke',
        10: 'XInputGetAudioDeviceIds',
        100: 'XInputGetStateEx',
        108: 'XInputGetCapabilitiesEx',
    });
    assert.equal(ordinals['XINPUT9_1_0.dll'], undefined,
        'xinput9_1_0.spec pins no number, so none is claimed');
});

test('every slot answers that no pad is connected there', ()=>{
    for (const dll of ['XINPUT9_1_0.dll', 'XINPUT1_4.dll'])
    {
        for (let index = 0; index < XUSER_MAX_COUNT; index++)
        {
            assert.equal(call(dll, 'XInputGetState', [index, OUT]), ERROR_DEVICE_NOT_CONNECTED);
            assert.equal(call(dll, 'XInputSetState', [index, OUT]), ERROR_DEVICE_NOT_CONNECTED);
            assert.equal(call(dll, 'XInputGetCapabilities', [index, XINPUT_FLAG_GAMEPAD, OUT]),
                ERROR_DEVICE_NOT_CONNECTED);
            assert.equal(call(dll, 'XInputGetCapabilities', [index, 0, OUT]),
                ERROR_DEVICE_NOT_CONNECTED, 'zero flags ask about every kind');
        }
    }
    const dll = 'XINPUT1_4.dll';
    assert.equal(call(dll, 'XInputGetStateEx', [0, OUT]), ERROR_DEVICE_NOT_CONNECTED);
    assert.equal(call(dll, 'XInputGetKeystroke', [0, 0, OUT]), ERROR_DEVICE_NOT_CONNECTED);
    assert.equal(call(dll, 'XInputGetKeystroke', [XUSER_INDEX_ANY, 0, OUT]),
        ERROR_DEVICE_NOT_CONNECTED, 'any slot at all');
    assert.equal(call(dll, 'XInputGetBatteryInformation', [3, BATTERY_DEVTYPE_GAMEPAD, OUT]),
        ERROR_DEVICE_NOT_CONNECTED);
    assert.equal(call(dll, 'XInputGetCapabilitiesEx', [1, 2, XINPUT_FLAG_GAMEPAD, OUT]),
        ERROR_DEVICE_NOT_CONNECTED);
    assert.equal(call(dll, 'XInputGetAudioDeviceIds', [0, OUT, OTHER, OUT, OTHER]),
        ERROR_DEVICE_NOT_CONNECTED);
    assert.equal(call('XINPUT9_1_0.dll', 'XInputGetDSoundAudioDeviceGuids', [0, OUT, OTHER]),
        ERROR_DEVICE_NOT_CONNECTED);
});

test('arguments are checked before the slot is, as Wine\'s xinput.c shows', ()=>{
    for (const dll of ['XINPUT9_1_0.dll', 'XINPUT1_4.dll'])
    {
        assert.equal(call(dll, 'XInputGetState', [0, 0]), ERROR_BAD_ARGUMENTS);
        assert.equal(call(dll, 'XInputGetState', [XUSER_MAX_COUNT, OUT]), ERROR_BAD_ARGUMENTS);
        assert.equal(call(dll, 'XInputGetState', [XUSER_MAX_COUNT + 1, OUT]),
            ERROR_BAD_ARGUMENTS);
        assert.equal(call(dll, 'XInputSetState', [XUSER_MAX_COUNT + 1, OUT]),
            ERROR_BAD_ARGUMENTS);
        assert.equal(call(dll, 'XInputGetCapabilities',
            [XUSER_MAX_COUNT + 1, XINPUT_FLAG_GAMEPAD, OUT]), ERROR_BAD_ARGUMENTS);
        assert.equal(call(dll, 'XInputGetCapabilities', [0, 2, OUT]), ERROR_BAD_ARGUMENTS,
            'a flag that is not XINPUT_FLAG_GAMEPAD');
    }
    const dll = 'XINPUT1_4.dll';
    assert.equal(call(dll, 'XInputGetStateEx', [XUSER_MAX_COUNT, OUT]), ERROR_BAD_ARGUMENTS);
    assert.equal(call(dll, 'XInputGetKeystroke', [XUSER_MAX_COUNT + 1, XINPUT_FLAG_GAMEPAD, OUT]),
        ERROR_BAD_ARGUMENTS);
    assert.equal(call(dll, 'XInputGetBatteryInformation',
        [XUSER_MAX_COUNT + 1, BATTERY_DEVTYPE_GAMEPAD, OUT]), ERROR_BAD_ARGUMENTS);
    const guids = 'XINPUT9_1_0.dll';
    assert.equal(call(guids, 'XInputGetDSoundAudioDeviceGuids', [0, 0, OTHER]),
        ERROR_BAD_ARGUMENTS);
    assert.equal(call(guids, 'XInputGetDSoundAudioDeviceGuids', [0, OUT, 0]),
        ERROR_BAD_ARGUMENTS);
    assert.equal(call(guids, 'XInputGetDSoundAudioDeviceGuids', [XUSER_MAX_COUNT + 1, OUT, OTHER]),
        ERROR_BAD_ARGUMENTS);
});

test('XInputEnable takes one argument and is remembered, for whoever measures', ()=>{
    const xinput = createXInput();
    const enable = xinput.libraries['XINPUT1_4.dll'].XInputEnable;
    assert.equal(enable.argBytes, 4);
    enable.handler([0]);
    xinput.libraries['XINPUT1_4.dll'].XInputGetState.handler([0, OUT]);
    assert.deepEqual(xinput.diagnostics(), { asked: 1, enabled: false });
});
