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
    IID_IWBEM_LOCATOR, IID_IWBEM_SERVICES, registerWbemClasses,
} from './wbem.js';

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

    assert.equal(host.call(instance, 'Get', [host.wide('Nonsense'), 0, variant, 0, 0]),
        0x80041002 | 0);
    assert.deepEqual(host.reported, ['IWbemClassObject::Get: no property Nonsense']);
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
        [host.wide('WQL'), host.wide('SELECT * FROM Win32_Processor'), 0, 0, OUT]), 0);
    assert.equal(host.call(host.view.getUint32(OUT, true), 'Next', [0, 1, 0x300, OUT + 4]), 1);
    assert.equal(host.view.getUint32(OUT + 4, true), 0);

    assert.equal(host.call(services, 'GetObject', [0, 0, 0, OUT, 0]), 0x8004100c | 0);
    assert.deepEqual(host.reported, [
        'IWbemLocator::ConnectServer: no namespace root\\default',
        'IWbemServices::ExecQuery: class Win32_Processor has no instances here; enumerated empty',
        'IWbemServices::GetObject: not implemented; refused',
    ]);
});
