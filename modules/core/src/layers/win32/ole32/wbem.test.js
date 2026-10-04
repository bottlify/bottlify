/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from './objects.js';
import {
    ADAPTER_RAM, CLSID_WBEM_LOCATOR, IID_IENUM_WBEM_CLASS_OBJECT, IID_IWBEM_CLASS_OBJECT,
    IID_IWBEM_LOCATOR, IID_IWBEM_SERVICES, WBEM_SCHEMAS, machineClasses, registerWbemClasses,
} from './wbem.js';
import { WINDOWS_VERSIONS } from '../kernel32/versions.js';

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {string[]} */
    const reported = [];
    /** @type {Map<number, any>} */
    const records = new Map();
    let nextPointer = 0x8000;
    let nextBlock = 0x4000;
    let nextString = 0x1000;
    const registry = createComRegistry();
    registerWbemClasses({
        registry,
        vtables: {
            publish(object, interfaceId){
                const record = object.interfaceFor(interfaceId);
                if (!record)
                {
                    return 0;
                }
                nextPointer += 0x10;
                records.set(nextPointer, record);
                return nextPointer;
            },
        },
        heap: { allocate: size=>(nextBlock += size + 16) - size - 16 },
        physicalMemory: 512 << 20,
        windows: WINDOWS_VERSIONS.winxp,
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    });
    return {
        registry, reported, view,
        /** @param {string} text  A BSTR's characters, which is what a method reads. */
        wide(text){
            const at = nextString + 4;
            for (let index = 0; index < text.length; index++)
            {
                view.setUint16(at + index * 2, text.charCodeAt(index), true);
            }
            view.setUint16(at + text.length * 2, 0, true);
            nextString = at + text.length * 2 + 2;
            return at;
        },
        /** @param {number} pointer @param {string} name @param {number[]} args */
        call(pointer, name, args){
            const record = records.get(pointer);
            assert.ok(record, `no interface at 0x${pointer.toString(16)}`);
            return record.methods.find((/** @type {any} */ m)=>m.name === name)
                .invoke(record.object, args);
        },
        /** @param {number} pointer */
        interfaceAt: pointer=>records.get(pointer).id,
    };
}

const OUT = 0x100;

test('there is one operating system, the Windows the process is told it runs on', ()=>{
    // A program takes the first instance without asking whether there was
    // one; with none it reads a pointer the enumerator never wrote.
    const host = setup();
    const object = /** @type {any} */ (host.registry.create(CLSID_WBEM_LOCATOR));
    const locator = object.interfaceFor(IID_IWBEM_LOCATOR);
    const connect = locator.methods.find((/** @type {any} */ m)=>m.name === 'ConnectServer');
    assert.equal(connect.invoke(object, [host.wide('root\\cimv2'), 0, 0, 0, 0, 0, 0, OUT]), 0);
    const services = host.view.getUint32(OUT, true);
    assert.equal(host.call(services, 'CreateInstanceEnum',
        [host.wide('Win32_OperatingSystem'), 1, 0, OUT]), 0);
    const enumerator = host.view.getUint32(OUT, true);
    assert.equal(host.call(enumerator, 'Next', [10000, 1, OUT, OUT + 4]), 0);
    assert.equal(host.view.getUint32(OUT + 4, true), 1);
    const instance = host.view.getUint32(OUT, true);
    /** @param {string} name */
    const text = name=>{
        const variant = 0x200;
        assert.equal(host.call(instance, 'Get', [host.wide(name), 0, variant, 0, 0]), 0);
        const bstr = host.view.getUint32(variant + 8, true);
        let read = '';
        for (let at = bstr; host.view.getUint16(at, true) !== 0; at += 2)
        {
            read += String.fromCharCode(host.view.getUint16(at, true));
        }
        return read;
    };
    assert.equal(text('Caption'), 'Microsoft Windows XP Professional');
    assert.equal(text('Version'), '5.1.2600');
    assert.equal(text('CSDVersion'), 'Service Pack 3');
    assert.equal(host.call(enumerator, 'Next', [10000, 1, OUT, OUT + 4]), 1, 'and only one');
});

test('a program reads the video controller\'s AdapterRAM the way it asks for it', ()=>{
    const host = setup();
    const object = /** @type {any} */ (host.registry.create(CLSID_WBEM_LOCATOR));
    const locator = object.interfaceFor(IID_IWBEM_LOCATOR);
    const connect = locator.methods.find((/** @type {any} */ m)=>m.name === 'ConnectServer');
    assert.equal(connect.argBytes, 36);

    const namespace = host.wide('\\\\.\\root\\CIMV2');
    assert.equal(connect.invoke(object, [namespace, 0, 0, 0, 0, 0, 0, OUT]), 0);
    const services = host.view.getUint32(OUT, true);
    assert.equal(host.interfaceAt(services), IID_IWBEM_SERVICES);

    assert.equal(host.call(services, 'CreateInstanceEnum',
        [host.wide('Win32_VideoController'), 1, 0, OUT]), 0);
    const enumerator = host.view.getUint32(OUT, true);
    assert.equal(host.interfaceAt(enumerator), IID_IENUM_WBEM_CLASS_OBJECT);

    // Next(timeout, 1, &instance, &returned): one instance, then none.
    assert.equal(host.call(enumerator, 'Next', [10000, 1, OUT, OUT + 4]), 0);
    assert.equal(host.view.getUint32(OUT + 4, true), 1);
    const instance = host.view.getUint32(OUT, true);
    assert.equal(host.interfaceAt(instance), IID_IWBEM_CLASS_OBJECT);
    assert.equal(host.call(enumerator, 'Next', [10000, 1, OUT + 8, OUT + 4]), 1);
    assert.equal(host.view.getUint32(OUT + 4, true), 0);

    // Get(L"AdapterRAM", 0, &variant, &type, &flavor): VT_I4 carrying the
    // bytes, typed CIM_UINT32.
    const variant = 0x200;
    assert.equal(host.call(instance, 'Get', [host.wide('AdapterRAM'), 0, variant, OUT, 0]), 0);
    assert.equal(host.view.getUint16(variant, true), 3);
    assert.equal(host.view.getUint32(variant + 8, true), ADAPTER_RAM);
    assert.equal(host.view.getUint32(OUT, true), 19);

    // A string property comes back as a BSTR with its byte length before it.
    assert.equal(host.call(instance, 'Get', [host.wide('Name'), 0, variant, 0, 0]), 0);
    assert.equal(host.view.getUint16(variant, true), 8);
    const bstr = host.view.getUint32(variant + 8, true);
    assert.ok(host.view.getUint32(bstr - 4, true) > 0);

    // One with no value kept is NULL, as WMI answers a property without one,
    // and said: an empty VARIANT reads to a client as a string.
    assert.equal(host.call(instance, 'Get', [host.wide('PNPDeviceID'), 0, variant, OUT, 0]), 0);
    assert.equal(host.view.getUint16(variant, true), 1, 'VT_NULL');
    assert.equal(host.view.getUint32(OUT, true), 8, 'CIM_STRING');
    assert.deepEqual(host.reported,
        ['IWbemClassObject::Get: no value kept for PNPDeviceID; it reads as NULL']);
});

test('a WQL query names its class; another namespace or class is refused or empty, and said', ()=>{
    const host = setup();
    const object = /** @type {any} */ (host.registry.create(CLSID_WBEM_LOCATOR));
    const connect = object.interfaceFor(IID_IWBEM_LOCATOR).methods[3];

    assert.equal(connect.invoke(object, [host.wide('root\\default'), 0, 0, 0, 0, 0, 0, OUT]),
        0x8004100e | 0);
    assert.equal(connect.invoke(object, [host.wide('ROOT\\CIMV2'), 0, 0, 0, 0, 0, 0, OUT]), 0);
    const services = host.view.getUint32(OUT, true);

    assert.equal(host.call(services, 'ExecQuery',
        [host.wide('WQL'), host.wide('SELECT * FROM Win32_VideoController'), 0, 0, OUT]), 0);
    const enumerator = host.view.getUint32(OUT, true);
    assert.equal(host.call(enumerator, 'Next', [0, 2, 0x300, OUT + 4]), 1);
    assert.equal(host.view.getUint32(OUT + 4, true), 1);

    assert.equal(host.call(services, 'ExecQuery',
        [host.wide('WQL'), host.wide('SELECT * FROM Win32_NetworkAdapter'), 0, 0, OUT]), 0);
    assert.equal(host.call(host.view.getUint32(OUT, true), 'Next', [0, 1, 0x300, OUT + 4]), 1);
    assert.equal(host.view.getUint32(OUT + 4, true), 0);

    assert.equal(host.call(services, 'GetObject', [0, 0, 0, OUT, 0]), 0x8004100c | 0);
    assert.deepEqual(host.reported, [
        'IWbemLocator::ConnectServer: no namespace root\\default',
        'IWbemServices::ExecQuery: class Win32_NetworkAdapter has no instances here; '
            + 'enumerated empty',
        'IWbemServices::GetObject: not implemented; refused',
    ]);
});

test('the machine classes answer as Windows does: one instance each, a boolean as VT_BOOL, '
    + 'an array as a SAFEARRAY of VT_I4, a 64-bit figure as a string', ()=>{
    const host = setup();
    const object = /** @type {any} */ (host.registry.create(CLSID_WBEM_LOCATOR));
    const connect = object.interfaceFor(IID_IWBEM_LOCATOR).methods[3];
    assert.equal(connect.invoke(object, [host.wide('root\\cimv2'), 0, 0, 0, 0, 0, 0, OUT]), 0);
    const services = host.view.getUint32(OUT, true);
    /** @param {string} name */
    const only = name=>{
        assert.equal(host.call(services, 'CreateInstanceEnum', [host.wide(name), 0, 0, OUT]), 0);
        const enumerator = host.view.getUint32(OUT, true);
        assert.equal(host.call(enumerator, 'Next', [0, 1, OUT, OUT + 4]), 0, `${name}: one`);
        const instance = host.view.getUint32(OUT, true);
        assert.equal(host.call(enumerator, 'Next', [0, 1, OUT + 8, OUT + 4]), 1, 'and no more');
        return instance;
    };
    const variant = 0x200;
    /** @param {number} instance @param {string} name */
    const get = (instance, name)=>{
        assert.equal(host.call(instance, 'Get', [host.wide(name), 0, variant, OUT, 0]), 0, name);
        return { vt: host.view.getUint16(variant, true),
            value: host.view.getUint32(variant + 8, true),
            cim: host.view.getUint32(OUT, true) };
    };
    /** @param {number} bstr */
    const text = bstr=>{
        let out = '';
        for (let at = bstr; host.view.getUint16(at, true) !== 0; at += 2)
        {
            out += String.fromCharCode(host.view.getUint16(at, true));
        }
        return out;
    };

    const bios = only('WIN32_BIOS');
    const date = get(bios, 'ReleaseDate');
    assert.deepEqual([date.vt, date.cim], [8, 101]);
    assert.match(text(date.value), /^\d{14}\.\d{6}[+-]\d{3}$/);
    const characteristics = get(bios, 'BiosCharacteristics');
    assert.deepEqual([characteristics.vt, characteristics.cim], [0x2003, 0x2012]);
    const array = characteristics.value;
    assert.equal(host.view.getUint16(array, true), 1, 'one dimension');
    assert.equal(host.view.getUint32(array + 4, true), 4, 'of four-byte elements');
    const count = host.view.getUint32(array + 16, true);
    assert.ok(count > 0);
    assert.equal(host.view.getUint32(host.view.getUint32(array + 12, true), true), 7, 'PCI first');

    const slot = only('Win32_SystemSlot');
    const hotPlug = get(slot, 'SupportsHotPlug');
    assert.deepEqual([hotPlug.vt, hotPlug.cim, hotPlug.value & 0xffff], [11, 11, 0]);

    const memory = only('Win32_PhysicalMemory');
    const capacity = get(memory, 'Capacity');
    assert.deepEqual([capacity.vt, capacity.cim], [8, 21]);
    assert.equal(text(capacity.value), String(512 << 20), 'the physical memory reported');
    assert.equal(get(only('Win32_PhysicalMemoryArray'), 'MaxCapacity').value, 512 << 10);

    const processor = get(only('Win32_Processor'), 'ProcessorId');
    assert.equal(text(processor.value), '0780A97900000673', 'CPUID leaf 1: EDX, then EAX');
    assert.equal(get(only('Win32_Processor'), 'MaxClockSpeed').value, 1000);

    const location = only('Win32_MemoryDeviceLocation');
    assert.equal(text(get(location, 'Antecedent').value),
        '\\\\BOTTLIFY\\root\\cimv2:Win32_PhysicalMemoryArray.Tag="Physical Memory Array 0"');
    assert.ok(text(get(only('WIN32_BaseBoard'), 'Product').value).length > 0);
    assert.ok(text(get(only('Win32_DiskDrive'), 'Model').value).length > 0);
    assert.deepEqual(host.reported, []);
});

test('a name the class does not have is WBEM_E_NOT_FOUND, its VARIANT left alone, as Windows '
    + 'answers; one it has with no value kept is NULL', ()=>{
    // A client that asks an association for a device's DeviceID checks for
    // WBEM_E_NOT_FOUND; made S_OK and NULL, its string conversion threw.
    const host = setup();
    const object = /** @type {any} */ (host.registry.create(CLSID_WBEM_LOCATOR));
    const connect = object.interfaceFor(IID_IWBEM_LOCATOR).methods[3];
    assert.equal(connect.invoke(object, [host.wide('root\\cimv2'), 0, 0, 0, 0, 0, 0, OUT]), 0);
    const services = host.view.getUint32(OUT, true);
    /** @param {string} name */
    const only = name=>{
        assert.equal(host.call(services, 'CreateInstanceEnum', [host.wide(name), 0, 0, OUT]), 0);
        assert.equal(host.call(host.view.getUint32(OUT, true), 'Next', [0, 1, OUT, OUT + 4]), 0);
        return host.view.getUint32(OUT, true);
    };
    const variant = 0x200;
    const WBEM_E_NOT_FOUND = 0x80041002 | 0;
    host.view.setUint16(variant, 0x1234, true);
    const location = only('Win32_MemoryDeviceLocation');
    assert.equal(host.call(location, 'Get', [host.wide('DeviceID'), 0, variant, 0, 0]),
        WBEM_E_NOT_FOUND);
    assert.equal(host.view.getUint16(variant, true), 0x1234, 'the VARIANT as it was');
    assert.equal(host.call(only('Win32_Processor'), 'Get',
        [host.wide('NoSuchProperty'), 0, variant, 0, 0]), WBEM_E_NOT_FOUND);
    assert.deepEqual(host.reported, [], 'what Windows answers is not said');

    assert.equal(host.call(only('Win32_Processor'), 'Get',
        [host.wide('l2cachesize'), 0, variant, 0, 0]), 0, 'a property of the class, any case');
    assert.equal(host.view.getUint16(variant, true), 1, 'VT_NULL');
});

test('every property kept is one its class has in Windows', ()=>{
    const classes = machineClasses({ physicalMemory: 512 << 20, windows: WINDOWS_VERSIONS.winxp });
    for (const [name, instances] of Object.entries(classes))
    {
        const schema = WBEM_SCHEMAS[name];
        assert.ok(schema, `${name} has a schema`);
        for (const property of instances.flatMap(instance=>Object.keys(instance)))
        {
            assert.ok(schema.has(property), `${name}.${property}`);
        }
    }
});
