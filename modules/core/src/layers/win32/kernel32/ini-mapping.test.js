/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createProfileFunctions } from './profile.js';
import { INI_FILE_MAPPING } from './ini-mapping.js';
import { decodeAnsi, encodeAnsi } from './locale.js';
import { createHive, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD, REG_SZ }
    from '../advapi32/registry.js';
import { createRegistryService } from '../advapi32/registry-service.js';

const MAP = 'winetest_map.ini';
const ON_DISK = `C:\\WINDOWS\\${MAP}`;

/**
 * The profile calls over guest memory, a volume of plain files and a
 * registry, with the A entry points called by strings.
 */
function setup(){
    const bytes = new Uint8Array(0x10000);
    let free = 0x100;
    /** @param {string | null} text */
    const put = text=>{
        if (text === null)
        {
            return 0;
        }
        const at = free;
        bytes.set(encodeAnsi(`${text}\0`), at);
        free += text.length + 1;
        return at;
    };
    /** @type {Map<string, Uint8Array>} */
    const nodes = new Map();
    const files = {
        /** @param {string} path */
        stat: path=>(nodes.has(path) ? { exists: true, isDirectory: false,
            size: /** @type {Uint8Array} */ (nodes.get(path)).length } : null),
        /** @param {string} path @param {any} mode */
        open(path, mode){
            if (!nodes.has(path) && !mode.create)
            {
                return null;
            }
            if (!nodes.has(path) || mode.truncate)
            {
                nodes.set(path, new Uint8Array(0));
            }
            return { path };
        },
        /** @param {{ path: string }} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>
            /** @type {Uint8Array} */ (nodes.get(node.path)).slice(offset, offset + length),
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} data */
        write(node, offset, data){
            nodes.set(node.path, data.slice());
            return data.length;
        },
        close(){},
        currentDirectory: ()=>'C:\\WORK',
    };
    const registry = createRegistryService(createHive());
    const fns = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        createProfileFunctions({
            guest: guestOver(bytes),
            files: /** @type {any} */ (files),
            setLastError(){},
            registry,
        }));
    const OUT = 0x8000;
    /** @param {string} name @param {(string | number | null)[]} args */
    const call = (name, args)=>fns[name].handler(args.map(arg=>(typeof arg === 'number'
        ? arg : put(arg))));
    /** @param {string} section @param {string} key @param {string} [file] */
    const get = (section, key, file = MAP)=>{
        const length = call('GetPrivateProfileStringA', [section, key, 'default', OUT, 200, file]);
        return decodeAnsi(bytes.subarray(OUT, OUT + length));
    };
    /** @param {string | null} section @param {string | null} key @param {string | null} value */
    const write = (section, key, value)=>call('WritePrivateProfileStringA',
        [section, key, value, MAP]);
    /** @param {string} name @param {number} [size] @returns {string} */
    const list = (name, size = 200)=>{
        const length = call(name, name.includes('Names')
            ? [OUT, size, MAP] : ['section6', OUT, size, MAP]);
        return decodeAnsi(bytes.subarray(OUT, OUT + length));
    };
    /** @param {number} root @param {string} path */
    const key = (root, path)=>registry.create(/** @type {number} */ (registry.root(root)),
        path).key;
    /** @param {number} at @param {string} name @param {string} value */
    const set = (at, name, value)=>registry.setValue(at, name, REG_SZ,
        encodeAnsi(`${value}\0`), true);
    /** @param {number} root @param {string} path @param {string} name */
    const value = (root, path, name)=>{
        const at = registry.open(/** @type {number} */ (registry.root(root)), path);
        const found = at === null ? null : registry.getValue(at, name);
        return found ? decodeAnsi(found.data).replace(/\0+$/, '') : null;
    };
    const mapping = key(HKEY_LOCAL_MACHINE, `${INI_FILE_MAPPING}\\${MAP}`);
    return { call, get, write, list, key, set, value, mapping, registry, nodes };
}

test('a section mapped by name lives in the key it names, the file untouched', ()=>{
    const { get, write, set, value, key, mapping, registry, nodes } = setup();
    set(mapping, 'section1', 'USR:winetest_map');
    assert.equal(get('section1', 'name1'), 'default');
    assert.equal(write('section1', 'name1', 'value1'), 1);
    assert.equal(value(HKEY_CURRENT_USER, 'winetest_map', 'name1'), 'value1');
    assert.equal(get('section1', 'name1'), 'value1');
    assert.equal(get('section1', 'name1', 'C:\\fake\\path\\winetest_map.ini'), 'value1',
        'the file is found by its name alone');
    assert.equal(nodes.has(ON_DISK), false);
    // Only strings are profile strings.
    registry.setValue(key(HKEY_CURRENT_USER, 'winetest_map'), 'name3', REG_DWORD,
        new Uint8Array([1, 0, 0, 0]), true);
    assert.equal(get('section1', 'name3'), 'default');
    write('section1', 'name1', null);
    assert.equal(value(HKEY_CURRENT_USER, 'winetest_map', 'name1'), null);
});

test('a section write adds to a mapped section and a NULL key empties it, its key kept', ()=>{
    const { call, get, write, set, mapping, registry } = setup();
    set(mapping, 'section1', 'USR:winetest_map');
    write('section1', 'name4', 'value4');
    write('section1', 'name5', 'value5');
    // The list is read up to an empty string, as it is in guest memory.
    assert.equal(call('WritePrivateProfileSectionA', ['section1', 'name4=four', MAP]), 1);
    assert.equal(get('section1', 'name4'), 'four');
    assert.equal(get('section1', 'name5'), 'value5');
    assert.equal(write('section1', null, null), 1);
    assert.equal(get('section1', 'name5'), 'default');
    assert.notEqual(registry.open(/** @type {number} */ (registry.root(HKEY_CURRENT_USER)),
        'winetest_map'), null);
});

test('the mapped sections are listed before the file\'s', ()=>{
    const { write, set, list, mapping } = setup();
    set(mapping, 'section1', 'USR:winetest_map');
    write('file_section', 'name1', 'value1');
    assert.equal(list('GetPrivateProfileSectionNamesA'), 'section1\0file_section\0');
    assert.equal(list('GetPrivateProfileSectionNamesA', 5), 'sec');
});

test('SYS: is under HKLM\\Software and the default maps a section to a key of its name', ()=>{
    const { get, write, set, value, mapping, registry } = setup();
    set(mapping, 'section2', 'SYS:winetest_map');
    write('section2', 'name1', 'value1');
    assert.equal(value(HKEY_LOCAL_MACHINE, 'Software\\winetest_map', 'name1'), 'value1');
    set(mapping, '', 'SYS:winetest_default');
    write('section4', 'name1', 'value1');
    assert.equal(value(HKEY_LOCAL_MACHINE, 'Software\\winetest_default\\section4', 'name1'),
        'value1');
    assert.equal(get('section2', 'name1'), 'value1', 'a named section keeps its own place');
    registry.deleteValue(mapping, '');
    assert.equal(get('section4', 'name1'), 'default', 'unmapped, it is the file again');
});

test('a section mapped name by name keeps the names it does not map in the file', ()=>{
    const { call, get, write, set, value, key, list, nodes } = setup();
    const sub = key(HKEY_LOCAL_MACHINE, `${INI_FILE_MAPPING}\\${MAP}\\section6`);
    set(sub, 'name1', 'USR:winetest_name1');
    set(sub, 'name2', 'SYS:winetest_name2');
    write('section6', 'name1', 'value1');
    write('section6', 'name2', 'value2');
    write('section6', 'name3', 'value3');
    assert.equal(value(HKEY_CURRENT_USER, 'winetest_name1', 'name1'), 'value1');
    assert.equal(value(HKEY_LOCAL_MACHINE, 'Software\\winetest_name2', 'name2'), 'value2');
    assert.match(new TextDecoder().decode(nodes.get(ON_DISK)), /name3=value3/);
    // A section write reaches only the mapped names.
    call('WritePrivateProfileSectionA', ['section6', 'name3=three', MAP]);
    assert.equal(get('section6', 'name3'), 'value3');
    assert.equal(list('GetPrivateProfileSectionA'), 'name1=value1\0name2=value2\0name3=value3\0');
    write('section6', null, null);
    for (const name of ['name1', 'name2', 'name3'])
    {
        assert.equal(get('section6', name), 'default');
    }
    // A default for the subkey claims every other name.
    set(sub, '', 'USR:winetest_default');
    write('section6', 'name3', 'value3');
    assert.equal(value(HKEY_CURRENT_USER, 'winetest_default', 'name3'), 'value3');
    assert.equal(list('GetPrivateProfileSectionA'), 'name3=value3\0');
});

test('all three NULL flushes and succeeds; a NULL section alone still fails', ()=>{
    const { write, call } = setup();
    assert.equal(write(null, null, null), 1);
    assert.equal(call('WritePrivateProfileStringA', [null, 'key', 'string', MAP]), 0);
});
