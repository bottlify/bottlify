/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHive } from '../advapi32/registry.js';
import { ENUM_KEY, createDeviceStore, interfacePath } from './devices.js';

const HKEY_LOCAL_MACHINE = 0x80000002;
const GUID = '{6a55b5a4-3f65-11db-b704-0011955c2bdb}';

test('an instance id has three parts, upper case but for the instance, and is made under ROOT',
    ()=>{
        // Wine's setupapi test_device_info and test_get_device_instance_id.
        const devices = createDeviceStore(createHive());
        assert.equal(devices.instanceId('Root\\legacy_bogus\\deadBeef', false, new Set()),
            'ROOT\\LEGACY_BOGUS\\deadBeef');
        for (const name of ['Root', 'Root\\LEGACY_BOGUS', 'Root\\LEGACY_BOGUS\\', ''])
        {
            assert.equal(devices.instanceId(name, false, new Set()), null, name);
        }
        const long = `Root\\LEGACY_BOGUS\\${'x'.repeat(200)}`;
        assert.equal(devices.instanceId(long.slice(0, 199), false, new Set()),
            `ROOT${long.slice(4, 199)}`, 'one shorter is not');
        assert.equal(devices.instanceId(long.slice(0, 200), false, new Set()), null,
            'MAX_DEVICE_ID_LEN with its terminator is too long');

        devices.createPhantom('ROOT\\LEGACY_BOGUS\\0000', GUID);
        assert.equal(devices.instanceId('LEGACY_BOGUS', true, new Set()),
            'ROOT\\LEGACY_BOGUS\\0001', 'the first instance neither the registry nor the set has');
        assert.equal(devices.instanceId('LEGACY_BOGUS', true,
            new Set(['ROOT\\LEGACY_BOGUS\\0001'])), 'ROOT\\LEGACY_BOGUS\\0002');
        assert.equal(devices.instanceId('ROOT\\LEGACY_BOGUS', true, new Set()), null,
            'a name to generate from is the device\'s alone');
    });

test('a phantom is in the registry marked, registered is unmarked, removed is gone', ()=>{
    // Wine's setupapi test_register_device_info.
    const hive = createHive();
    const devices = createDeviceStore(hive);
    const id = 'ROOT\\LEGACY_BOGUS\\0000';
    devices.createPhantom(id, GUID);
    const machine = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    const key = /** @type {any} */ (hive.open(machine, `${ENUM_KEY}\\${id}`));
    assert.deepEqual([...(hive.getValue(key, 'Phantom')?.data ?? [])], [1, 0, 0, 0]);
    assert.equal(devices.exists(id), true);
    assert.equal(devices.registered(id), false);
    assert.equal(devices.classOf(id), GUID);

    devices.register(id);
    assert.equal(hive.getValue(key, 'Phantom'), null);
    assert.equal(devices.registered(id), true);

    devices.addInterface(id, GUID, '');
    devices.addInterface(id, GUID, 'test');
    assert.deepEqual(devices.storedInterfaces(id), [{ classGuid: GUID, reference: '' },
        { classGuid: GUID, reference: 'test' }]);
    devices.removeInterface(id, GUID, 'test');
    assert.deepEqual(devices.storedInterfaces(id), [{ classGuid: GUID, reference: '' }]);

    devices.removeInstance(id);
    assert.equal(devices.exists(id), false);
    assert.deepEqual(devices.storedInterfaces(id), [], 'its interfaces with it');
    assert.equal(devices.devnodeOf(id), devices.devnodeOf(id.toLowerCase()),
        'one node for one instance, its case aside');
});

test('instances enumerate sorted, the machine\'s hardware among them, and paths are lower case',
    ()=>{
        // Wine's setupapi test_get_class_devs: BAR before FOO before QUX.
        const devices = createDeviceStore(createHive());
        devices.seedMachine();
        for (const instance of ['qux', 'foo', 'bar'])
        {
            devices.createPhantom(`ROOT\\LEGACY_BOGUS\\${instance}`, GUID);
        }
        assert.deepEqual(devices.allInstances(), [
            'DISPLAY\\DEFAULT_MONITOR\\0000',
            'PCI\\VEN_0000&DEV_0000&SUBSYS_00000000&REV_00\\0000',
            'ROOT\\LEGACY_BOGUS\\bar', 'ROOT\\LEGACY_BOGUS\\foo', 'ROOT\\LEGACY_BOGUS\\qux',
        ]);
        assert.equal(devices.registered('DISPLAY\\DEFAULT_MONITOR\\0000'), true,
            'the monitor is there from the start');
        assert.equal(devices.storedInterfaces('DISPLAY\\DEFAULT_MONITOR\\0000')[0].classGuid,
            '{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}');
        assert.equal(interfacePath('ROOT\\LEGACY_BOGUS\\0000', GUID.toUpperCase(), 'Oogah'),
            '\\\\?\\root#legacy_bogus#0000#{6a55b5a4-3f65-11db-b704-0011955c2bdb}\\oogah');
    });
