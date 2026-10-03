/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsVersion } from '../kernel32/versions.js';
import { createComRegistry } from './objects.js';
import {
    CLSID_DXDIAG_PROVIDER, DXDIAG_DX9_SDK_VERSION, DXDIAG_E_INSUFFICIENT_BUFFER,
    IID_IDXDIAG_CONTAINER, IID_IDXDIAG_PROVIDER, dxDiagTree, registerDxDiagClasses,
} from './dxdiag.js';
import { DIRECTX_RELEASES } from '../advapi32/registry.js';
import { ADAPTER_NAME, ADAPTER_RAM } from './wbem.js';

const S_OK = 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
const VT_UI4 = 19;
const VT_BSTR = 8;

/** @param {{ width: number, height: number, bitsPerPixel: number }} [screen] */
function setup(screen){
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
    registerDxDiagClasses({
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
        windows: windowsVersion('winxp'),
        screen,
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    });
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let from = at; view.getUint16(from, true) !== 0; from += 2)
        {
            text += String.fromCharCode(view.getUint16(from, true));
        }
        return text;
    };
    return {
        registry, reported, view, wideAt,
        /** @param {string} text */
        wide(text){
            const at = nextString;
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
const PARAMS = 0x200;
const VARIANT = 0x300;
const NAME = 0x400;

/**
 * A provider as CoCreateInstance hands it out, and a call on it.
 *
 * @param {ReturnType<typeof setup>} host
 */
function provider(host){
    const object = /** @type {any} */ (host.registry.create(CLSID_DXDIAG_PROVIDER));
    const face = object.interfaceFor(IID_IDXDIAG_PROVIDER);
    return (/** @type {string} */ name, /** @type {number[]} */ args)=>face.methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
}

/**
 * DXDIAG_INIT_PARAMS at PARAMS.
 *
 * @param {ReturnType<typeof setup>} host @param {number} size @param {number} header
 */
function initParams(host, size, header){
    host.view.setUint32(PARAMS, size, true);
    host.view.setUint32(PARAMS + 4, header, true);
    host.view.setUint32(PARAMS + 8, 0, true);
    host.view.setUint32(PARAMS + 12, 0, true);
    return PARAMS;
}

test('the SDK\'s way of asking which DirectX this is reads 9, 0 and c from DxDiag_SystemInfo', ()=>{
    // GetDXVer: Initialize with the dx9 header, the root, DxDiag_SystemInfo,
    // then dwDirectXVersionMajor and Minor as VT_UI4 and the letter as a BSTR.
    const host = setup();
    const call = provider(host);
    assert.equal(call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]), S_OK);
    assert.equal(call('GetRootContainer', [OUT]), S_OK);
    const root = host.view.getUint32(OUT, true);
    assert.equal(host.interfaceAt(root), IID_IDXDIAG_CONTAINER);
    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_SystemInfo'), OUT]), S_OK);
    const system = host.view.getUint32(OUT, true);

    /** @param {string} name */
    const prop = name=>{
        assert.equal(host.call(system, 'GetProp', [host.wide(name), VARIANT]), S_OK, name);
        return { vt: host.view.getUint16(VARIANT, true),
            value: host.view.getUint32(VARIANT + 8, true) };
    };
    assert.deepEqual(prop('dwDirectXVersionMajor'), { vt: VT_UI4, value: 9 });
    assert.deepEqual(prop('dwDirectXVersionMinor'), { vt: VT_UI4, value: 0 });
    const letter = prop('szDirectXVersionLetter');
    assert.equal(letter.vt, VT_BSTR);
    assert.equal(host.view.getUint32(letter.value - 4, true), 2,
        'one character, as a BSTR counts it');
    assert.equal(host.wideAt(letter.value), 'c');
    const english = prop('szDirectXVersionEnglish');
    assert.equal(host.wideAt(english.value), '4.09.0000.0904', 'the version the registry names');
    assert.deepEqual(prop('dwOSMajorVersion'), { vt: VT_UI4, value: 5 });
    assert.deepEqual(prop('dwOSMinorVersion'), { vt: VT_UI4, value: 1 });
});

test('Initialize wants the block\'s own size and the dx9 header, and the root waits for it', ()=>{
    const host = setup();
    const call = provider(host);
    assert.equal(call('GetRootContainer', [OUT]), CO_E_NOTINITIALIZED);
    assert.equal(call('Initialize', [0]), E_POINTER);
    assert.equal(call('Initialize', [initParams(host, 0, DXDIAG_DX9_SDK_VERSION)]), E_INVALIDARG);
    assert.equal(call('Initialize', [initParams(host, 16, 0)]), E_INVALIDARG);
    assert.equal(call('GetRootContainer', [OUT]), CO_E_NOTINITIALIZED, 'a refused one is not one');
    assert.equal(call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]), S_OK);
    assert.equal(call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]), S_OK,
        'and again');
    assert.equal(call('GetRootContainer', [0]), E_INVALIDARG);
});

test('a container counts and names its children and properties, and refuses what it lacks', ()=>{
    const host = setup();
    const call = provider(host);
    call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]);
    call('GetRootContainer', [OUT]);
    const root = host.view.getUint32(OUT, true);

    assert.equal(host.call(root, 'GetNumberOfChildContainers', [0]), E_INVALIDARG);
    assert.equal(host.call(root, 'GetNumberOfChildContainers', [OUT]), S_OK);
    const children = host.view.getUint32(OUT, true);
    assert.ok(children >= 1);
    const names = Array.from({ length: children }, (_, index)=>{
        assert.equal(host.call(root, 'EnumChildContainerNames', [index, NAME, 64]), S_OK);
        return host.wideAt(NAME);
    });
    assert.ok(names.includes('DxDiag_SystemInfo'), names.join());

    // A buffer too short for the name gets as much of it as fits.
    const at = names.indexOf('DxDiag_SystemInfo');
    assert.equal(host.call(root, 'EnumChildContainerNames', [at, NAME, 7]),
        DXDIAG_E_INSUFFICIENT_BUFFER);
    assert.equal(host.wideAt(NAME), 'DxDiag');
    assert.equal(host.call(root, 'EnumChildContainerNames', [at, NAME, 0]), E_INVALIDARG);
    assert.equal(host.call(root, 'EnumChildContainerNames', [children, NAME, 64]), E_INVALIDARG,
        'past the end');
    assert.equal(host.wideAt(NAME), '', 'with the buffer emptied');

    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_Nothing'), OUT]),
        E_INVALIDARG);
    assert.equal(host.call(root, 'GetChildContainer', [host.wide(''), OUT]), E_INVALIDARG);
    assert.equal(host.call(root, 'GetChildContainer', [0, OUT]), E_INVALIDARG);
    assert.ok(host.reported.some(line=>line.includes('DxDiag_Nothing')), host.reported.join('\n'));

    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_SystemInfo'), OUT]), S_OK);
    const system = host.view.getUint32(OUT, true);
    assert.equal(host.call(system, 'GetNumberOfProps', [OUT]), S_OK);
    const count = host.view.getUint32(OUT, true);
    const props = Array.from({ length: count }, (_, index)=>{
        assert.equal(host.call(system, 'EnumPropNames', [index, NAME, 64]), S_OK);
        return host.wideAt(NAME);
    });
    assert.ok(props.includes('szDirectXVersionLetter'), props.join());
    assert.equal(host.call(system, 'GetProp', [host.wide('szNothing'), VARIANT]), E_INVALIDARG);
    assert.equal(host.call(system, 'GetProp', [host.wide('bDebug'), 0]), E_INVALIDARG);
});

test('a dotted name is a path: an empty part, or one not under the one before it, names none', ()=>{
    const host = setup();
    const call = provider(host);
    call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]);
    call('GetRootContainer', [OUT]);
    const root = host.view.getUint32(OUT, true);
    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_SystemInfo.'), OUT]),
        E_INVALIDARG, 'an empty part names nothing');
    assert.equal(host.call(root, 'GetChildContainer', [host.wide('.DxDiag_SystemInfo'), OUT]),
        E_INVALIDARG);
    assert.equal(host.call(root, 'GetChildContainer',
        [host.wide('DxDiag_SystemInfo.DxDiag_SystemInfo'), OUT]), E_INVALIDARG,
    'each part is looked for under the one before it');
});

test('the display device says how much video memory there is, and the mode Initialize found', ()=>{
    // A configuration tool reads DxDiag_DisplayDevices.0's memory as text and
    // compares the number with what its game needs.
    const screen = { width: 1024, height: 768, bitsPerPixel: 32 };
    const host = setup(screen);
    const call = provider(host);
    assert.equal(call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]), S_OK);
    call('GetRootContainer', [OUT]);
    const root = host.view.getUint32(OUT, true);
    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_DisplayDevices'), OUT]),
        S_OK);
    const displays = host.view.getUint32(OUT, true);
    assert.equal(host.call(displays, 'GetNumberOfChildContainers', [OUT]), S_OK);
    assert.equal(host.view.getUint32(OUT, true), 1, 'one adapter');
    assert.equal(host.call(displays, 'EnumChildContainerNames', [0, NAME, 64]), S_OK);
    assert.equal(host.wideAt(NAME), '0');
    assert.equal(host.call(root, 'GetChildContainer', [host.wide('DxDiag_DisplayDevices.0'), OUT]),
        S_OK);
    const device = host.view.getUint32(OUT, true);
    /** @param {string} name */
    const prop = name=>{
        assert.equal(host.call(device, 'GetProp', [host.wide(name), VARIANT]), S_OK, name);
        const vt = host.view.getUint16(VARIANT, true);
        const value = host.view.getUint32(VARIANT + 8, true);
        return vt === VT_BSTR ? host.wideAt(value) : value;
    };
    assert.equal(prop('szDisplayMemoryEnglish'), `${(ADAPTER_RAM / 1048576).toFixed(1)} MB`,
        'the figure WMI and GetAvailableTextureMem give');
    assert.equal(prop('szDisplayMemoryLocalized'), '256.0 MB');
    assert.equal(prop('szDisplayModeEnglish'), '1024 x 768 (32 bit) (60Hz)');
    assert.equal(prop('dwWidth'), 1024);
    assert.equal(prop('szDescription'), ADAPTER_NAME);
    assert.equal(prop('b3DAccelerationEnabled'), 0xffff);
    assert.equal(prop('bNoHardware'), 0);

    // A mode changed afterwards is what the next Initialize gathers.
    screen.width = 800;
    screen.height = 600;
    call('Initialize', [initParams(host, 16, DXDIAG_DX9_SDK_VERSION)]);
    call('GetRootContainer', [OUT]);
    const again = host.view.getUint32(OUT, true);
    host.call(again, 'GetChildContainer', [host.wide('DxDiag_DisplayDevices.0'), OUT]);
    const now = host.view.getUint32(OUT, true);
    assert.equal(host.call(now, 'GetProp', [host.wide('dwWidth'), VARIANT]), S_OK);
    assert.equal(host.view.getUint32(VARIANT + 8, true), 800);
    assert.deepEqual(host.reported, []);
});

test('a bottle that names its DirectX is that release in DxDiag_SystemInfo', ()=>{
    const tree = dxDiagTree(windowsVersion(), { width: 640, height: 480, bitsPerPixel: 32 },
        DIRECTX_RELEASES[8]);
    const system = tree.children.get('DxDiag_SystemInfo')?.properties;
    assert.deepEqual(['dwDirectXVersionMajor', 'dwDirectXVersionMinor', 'szDirectXVersionLetter',
        'szDirectXVersionEnglish'].map(name=>system?.get(name)?.value),
    [8, 1, ' ', '4.08.0001.0881']);
});
