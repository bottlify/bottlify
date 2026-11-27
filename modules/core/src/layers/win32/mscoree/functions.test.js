/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLR_E_SHIM_RUNTIMELOAD, MSCOREE_FORWARDS, MSCOREE_ORDINALS, STATUS_DLL_NOT_FOUND,
    createMscoreeFunctions, forwardingStub } from './functions.js';

const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;

/**
 * A host with guest memory of its own, a shim where `files` says, and a record
 * of what was loaded, ended and said.
 *
 * @param {{ files?: string[], installRoot?: string | null,
 *     exports?: Record<string | number, number> }} [given]
 */
function hostFor({ files = [], installRoot = null, exports = {} } = {}){
    const memory = new Map();
    let next = 0x100000;
    /** @type {string[]} */
    const loaded = [];
    /** @type {number[]} */
    const ended = [];
    /** @type {{ api: string, detail: string, kind?: string }[]} */
    const said = [];
    /** @type {Map<number, { label: string, trap: any }>} */
    const traps = new Map();
    const host = {
        allocate: ()=>(next += 0x1000) - 0x1000,
        allocateCode: ()=>(next += 0x1000) - 0x1000,
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            bytes.forEach((byte, index)=>memory.set(at + index, byte)),
        installRoot: ()=>installRoot,
        windowsDirectory: ()=>'C:\\WINDOWS',
        exists: (/** @type {string} */ path)=>files.includes(path),
        loadLibrary: async(/** @type {string} */ path)=>{
            loaded.push(path);
            return 0x7000000;
        },
        procAddress: async(/** @type {number} */ _module, /** @type {string | number} */ name)=>
            exports[name] ?? 0,
        exitProcess: (/** @type {number} */ code)=>{
            ended.push(code);
            return 'parked';
        },
        divergence: (/** @type {string} */ api, /** @type {string} */ detail,
            /** @type {string | undefined} */ kind)=>said.push({ api, detail, kind }),
    };
    let trapAt = 0x50000;
    /** @param {string} label @param {any} trap */
    const register = (label, trap)=>{
        trapAt += 0x10;
        traps.set(trapAt, { label, trap });
        return trapAt;
    };
    const table = createMscoreeFunctions(host);
    /** @param {number} at */
    const u32 = at=>[0, 1, 2, 3].reduce((sum, index)=>sum + (memory.get(at + index) ?? 0)
        * 2 ** (8 * index), 0);
    /** @param {number} at */
    const i32 = at=>u32(at) | 0;
    /**
     * An export's stub placed, and its slot and two traps read back from it.
     *
     * @param {string} name
     */
    const place = name=>{
        const at = table[name].guest({ register });
        const resolve = traps.get(at + 14 + i32(at + 10));
        const failed = traps.get(at + 25 + i32(at + 21));
        return { at, slot: u32(at + 1), resolve, failed };
    };
    return { table, place, u32, loaded, ended, said };
}

test('the stub reads its slot, calls its resolver and jumps to its failure where it says', ()=>{
    const code = forwardingStub(0x1000, 0x2000, 0x3000, 0x4000);
    const view = new DataView(code.buffer);
    assert.equal(code.length, 25);
    assert.equal(code[0], 0xa1, 'mov eax, [slot]');
    assert.equal(view.getUint32(1, true), 0x2000);
    assert.equal(code[9], 0xe8, 'call');
    assert.equal(0x1000 + 14 + view.getInt32(10, true), 0x3000);
    assert.deepEqual([...code.subarray(18, 20)], [0xff, 0xe0], 'jmp eax');
    assert.equal(code[20], 0xe9, 'jmp');
    assert.equal(0x1000 + 25 + view.getInt32(21, true), 0x4000);
});

test('the first call loads the shim from InstallRoot once and fills each slot', async()=>{
    const path = 'D:\\NET\\v4.0.30319\\mscoreei.dll';
    const f = hostFor({ files: [path], installRoot: 'D:\\NET',
        exports: { GetCORVersion: 0x7001000, CLRCreateInstance: 0x7002000, 24: 0x7003000 } });
    const version = f.place('GetCORVersion');
    const create = f.place('CLRCreateInstance');
    assert.notEqual(version.slot, create.slot);
    assert.equal(version.resolve?.label, 'mscoree.dll!GetCORVersion');
    assert.equal(f.u32(version.slot), 0, 'empty until called');
    assert.equal(await version.resolve?.trap.handler([]), 0x7001000);
    assert.equal(await create.resolve?.trap.handler([]), 0x7002000);
    assert.equal(f.u32(version.slot), 0x7001000);
    assert.equal(f.u32(create.slot), 0x7002000);
    assert.deepEqual(f.loaded, [path], 'loaded once, from InstallRoot');
    assert.equal(await f.place('#24').resolve?.trap.handler([]), 0x7003000, 'by number');
});

test('a name the shim does not export answers as with no runtime, and is said', async()=>{
    const path = 'C:\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\mscoreei.dll';
    const f = hostFor({ files: [path] });
    const version = f.place('GetCORVersion');
    assert.equal(await version.resolve?.trap.handler([]), 0);
    assert.equal(f.u32(version.slot), 0);
    assert.deepEqual(f.loaded, [path], 'the default InstallRoot');
    assert.match(f.said[0].detail, /exports no GetCORVersion/);
    assert.equal(version.failed?.trap.handler([0, 0, 0]), CLR_E_SHIM_RUNTIMELOAD);
});

test('with no .NET Framework, each export answers its documented failure', async()=>{
    const f = hostFor();
    /** @param {string} name @param {number[]} [args] */
    const fail = async(name, args = [])=>{
        const placed = f.place(name);
        assert.equal(await placed.resolve?.trap.handler([]), 0, `${name}: nothing to forward to`);
        return placed.failed?.trap.handler(args);
    };
    assert.equal(await fail('GetCORVersion'), CLR_E_SHIM_RUNTIMELOAD);
    assert.equal(await fail('CLRCreateInstance'), CLR_E_SHIM_RUNTIMELOAD);
    assert.equal(await fail('DllGetClassObject'), CLASS_E_CLASSNOTAVAILABLE);
    assert.equal(await fail('StrongNameSignatureVerificationEx'), 0, 'FALSE');
    assert.equal(f.loaded.length, 0, 'nothing to load');
    assert.equal(f.said.length, 0, 'what Windows answers is no divergence');

    assert.equal(await fail('_CorDllMain'), 0, 'the managed library does not load');
    assert.equal(f.said.at(-1)?.kind, 'loss');
    assert.equal(await fail('CorExitProcess', [7]), 'parked');
    assert.deepEqual(f.ended, [7]);
    assert.equal(await fail('_CorExeMain'), 'parked');
    assert.deepEqual(f.ended, [7, STATUS_DLL_NOT_FOUND]);
    assert.equal(f.said.at(-1)?.api, '_CorExeMain');
    assert.equal(f.said.at(-1)?.kind, 'loss');
    assert.match(f.said.at(-1)?.detail ?? '', /no \.NET Framework is installed/);
});

test('the exports carry the numbers of Windows\' mscoree', ()=>{
    // Read off the export table of Windows' mscoree.dll (4.0.31106 and 10.0).
    const numbers = { 17: 'InitErrors', 23: 'ReOpenMetaDataWithMemory', 25: 'CollectCtrs',
        38: 'CLRCreateInstance', 54: 'CorGetSvc', 67: 'GetAssemblyMDImport',
        69: 'GetCORRequiredVersion', 72: 'GetCORVersion', 109: 'ND_WU1', 136: '_CorDllMain',
        137: '_CorExeMain2', 138: '_CorExeMain', 139: '_CorImageUnloading',
        140: '_CorValidateImage', 142: 'GetVersionExW' };
    for (const [ordinal, name] of Object.entries(numbers))
    {
        assert.equal(MSCOREE_ORDINALS[Number(ordinal)], name, `#${ordinal}`);
    }
    assert.equal(MSCOREE_ORDINALS[24], '#24', 'by number alone');
    assert.equal(MSCOREE_ORDINALS[68], undefined);
    assert.equal(Object.keys(MSCOREE_ORDINALS).length, MSCOREE_FORWARDS.length + 3);
});

test('mscoree\'s own notifications answer without the shim', ()=>{
    const f = hostFor();
    assert.equal(f.table._CorValidateImage.handler([0, 0]), 0);
    assert.equal(f.table._CorImageUnloading.handler([0]), 0);
    assert.equal(MSCOREE_FORWARDS.some(([name])=>name === '_CorValidateImage'), false);
});
