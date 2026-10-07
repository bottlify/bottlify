/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvpackFunctions } from './functions.js';
import { HKEY_CLASSES_ROOT, REG_EXPAND_SZ, REG_SZ, createHive } from '../advapi32/registry.js';
import { decodeAnsi } from '../kernel32/locale.js';

test('IsNTAdmin says whether the account is in BUILTIN\\Administrators', ()=>{
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>true }).IsNTAdmin.handler(), 1);
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>false }).IsNTAdmin.handler(), 0);
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>true }).IsNTAdmin.argBytes, 8,
        'two reserved arguments, popped by the callee');
});

/**
 * A library mapped at BASE with a REGINST INF among its resources, and memory
 * holding a string table its DllRegisterServer would hand over.
 *
 * @param {string} inf @param {[string, string][]} table @param {boolean} [wide]
 */
function library(inf, table, wide = false){
    const BASE = 0x10000000;
    const memory = new Uint8Array(0x10000);
    const MEMORY = 0x20000;
    const bytes = new TextEncoder().encode(inf);
    memory.set(bytes, 0x100);
    let next = 0x8000;
    /** @param {string} text */
    const put = text=>{
        const at = next;
        for (let index = 0; index < text.length; index++)
        {
            if (wide)
            {
                memory[at + index * 2] = text.charCodeAt(index);
            }
            else
            {
                memory[at + index] = text.charCodeAt(index);
            }
        }
        next += (text.length + 1) * (wide ? 2 : 1) + 4;
        return MEMORY + at;
    };
    const view = new DataView(memory.buffer);
    view.setUint32(0x7000, table.length, true);
    view.setUint32(0x7004, MEMORY + 0x7100, true);
    table.forEach(([name, value], index)=>{
        view.setUint32(0x7100 + index * 8, put(name), true);
        view.setUint32(0x7104 + index * 8, put(value), true);
    });
    const section = put('Reg');
    const unregister = put('Unreg');
    /** @param {number} address @param {number} length */
    const read = (address, length)=>(address >= BASE
        ? memory.subarray(address - BASE, address - BASE + length)
        : memory.subarray(address - MEMORY, address - MEMORY + length));
    /** @param {number} address @param {number} max @param {number} unit */
    const text = (address, max, unit)=>{
        let out = '';
        for (let at = address - MEMORY; out.length < max; at += unit)
        {
            const code = unit === 2 ? memory[at] | memory[at + 1] << 8 : memory[at];
            if (code === 0)
            {
                break;
            }
            out += String.fromCharCode(code);
        }
        return out;
    };
    const hive = createHive();
    /** @type {string[]} */
    const said = [];
    const functions = createAdvpackFunctions({
        isAdministrator: ()=>true,
        hive,
        folders: { Windows: 'C:\\WINDOWS', System: 'C:\\WINDOWS\\system32' },
        findResource: (instance, type, name)=>(instance === BASE && type === 'REGINST'
            && name === 'REGINST' ? { rva: 0x100, size: bytes.length } : null),
        moduleBase: instance=>(instance === BASE ? BASE : 0),
        modulePath: ()=>'C:\\WINDOWS\\system32\\server.dll',
        readMemory: read,
        readCString: (address, max)=>text(address, max, 1),
        readWideString: (address, max)=>text(address, max, 2),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    return { BASE, functions, hive, said, table: MEMORY + 0x7000, section, unregister };
}

const SERVER_INF = `[Version]
Signature="$CHICAGO$"
[Reg]
ComponentName=server.dll
AddReg=Server.Reg
[Unreg]
DelReg=Server.Reg
[Server.Reg]
HKCR,CLSID\\%CLSID_Server%,,,"%NAME%"
HKCR,CLSID\\%CLSID_Server%\\InProcServer32,,%REG_EXPAND_SZ%,%_SYS_MOD_PATH%
HKCR,CLSID\\%CLSID_Server%\\InProcServer32,"ThreadingModel",,"%MODEL%"
HKCR,CLSID\\%CLSID_Server%\\Path,,,%_MOD_PATH%
[Strings]
CLSID_Server="{11111111-2222-3333-4444-555555555555}"
NAME="From the INF"
REG_EXPAND_SZ = 0x00020000
`;

/**
 * @param {ReturnType<typeof createHive>} hive @param {string} path @param {string} name
 */
const valueAt = (hive, path, name)=>{
    const key = hive.open(/** @type {any} */ (hive.root(HKEY_CLASSES_ROOT)), path);
    const value = key ? hive.getValue(key, name) : null;
    return value ? { type: value.type, text: decodeAnsi(value.data) } : null;
};

for (const wide of [false, true])
{
    test(`RegInstall${wide ? 'W' : ''} carries out a section of the module's REGINST INF, the`
        + ' strings it is handed over the INF\'s own', ()=>{
        const { BASE, functions, hive, said, table, section } = library(SERVER_INF,
            [['MODEL', 'Both'], ['NAME', 'From the table']], wide);
        const call = wide ? functions.RegInstallW : functions.RegInstall;
        assert.equal(call.argBytes, 12);
        assert.equal(call.handler([BASE, section, table]), 0, 'S_OK');
        const clsid = 'CLSID\\{11111111-2222-3333-4444-555555555555}';
        assert.deepEqual(valueAt(hive, clsid, ''), { type: REG_SZ, text: 'From the table\0' });
        assert.deepEqual(valueAt(hive, `${clsid}\\InProcServer32`, ''),
            { type: REG_EXPAND_SZ, text: '%SystemRoot%\\system32\\server.dll\0' },
            '_SYS_MOD_PATH: the module\'s path from %SystemRoot%');
        assert.deepEqual(valueAt(hive, `${clsid}\\InProcServer32`, 'ThreadingModel'),
            { type: REG_SZ, text: 'Both\0' });
        assert.deepEqual(valueAt(hive, `${clsid}\\Path`, ''),
            { type: REG_SZ, text: 'C:\\WINDOWS\\system32\\server.dll\0' }, '_MOD_PATH');
        assert.deepEqual(said, [], 'ComponentName only describes the section');
    });
}

test('RegInstall\'s other sections undo it, and a module with no INF or no such section fails',
    ()=>{
        const { BASE, functions, hive, table, section, unregister } = library(SERVER_INF, []);
        const clsid = 'CLSID\\{11111111-2222-3333-4444-555555555555}';
        assert.equal(functions.RegInstall.handler([BASE, section, table]), 0);
        const classes = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
        assert.ok(hive.open(classes, clsid));
        assert.equal(functions.RegInstall.handler([BASE, unregister, table]), 0);
        assert.equal(hive.open(classes, clsid), null,
            'its DelReg takes the key and everything under it');

        const E_FAIL = 0x80004005;
        assert.equal(functions.RegInstall.handler([0x30000000, section, table]) >>> 0, E_FAIL,
            'no REGINST resource');
        const missing = library(SERVER_INF.replace('[Reg]', '[Elsewhere]'), []);
        assert.equal(missing.functions.RegInstall.handler([missing.BASE, missing.section,
            missing.table]) >>> 0, E_FAIL, 'no such section');
        assert.match(missing.said.join('\n'), /no section \[Reg\]/);
    });
