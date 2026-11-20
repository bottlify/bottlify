/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModuleTable, pathKey } from './module-table.js';

/** A name's key as the loader's: its file's name, any case, without .dll. @param {string} name */
const keyOf = name=>name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1)
    .toLowerCase().replace(/\.dll$/, '');

/**
 * A table whose paths are searched in the program's directory and system32,
 * as LoadLibrary searches a relative one.
 *
 * @param {Record<string, string[]>} [imports]  the keys each key brings in
 */
function setup(imports = {}){
    /** @type {any[]} */
    const told = [];
    const table = createModuleTable({
        keyOf,
        placesNamed: path=>(/^[a-z]:/i.test(path) ? [path]
            : [`C:\\App\\${path}`, `C:\\Windows\\system32\\${path}`]).map(pathKey),
        importsOf: (/** @type {any} */ module)=>imports[keyOf(module.name)] ?? [],
        onLoaded: (/** @type {any} */ module)=>told.push(module.name),
    });
    return { table, told };
}

/** @param {string} name @param {number} base @param {object} [more] */
const record = (name, base, more = {})=>({ name, base, size: 0x10000, ...more });

test('a bare name finds the first module of its name, a path only the file it names', ()=>{
    const { table } = setup();
    const system = record('foo.dll', 0x10000000);
    const shipped = record('foo.dll', 0x20000000,
        { fromFile: true, path: 'C:\\App\\foo.dll' });
    table.add(system, 'foo');
    table.add(shipped, 'foo', 'first');
    assert.equal(table.find('FOO.DLL'), system, 'the bare name keeps the module that came first');
    assert.equal(table.find('C:\\App\\foo.dll'), shipped);
    assert.equal(table.find('c:/app//FOO.dll'), shipped, 'one separator, any case');
    assert.equal(table.find('C:\\Other\\foo.dll'), system,
        'a path no module was read from falls back to the bare name');
    assert.equal(table.answersPath('foo.dll', shipped), true);
    assert.equal(table.answersPath('C:\\Other\\foo.dll', shipped), false);
    assert.equal(table.answersPath('C:\\App\\foo.dll', shipped), true);
});

test('a module taken out passes its name to the next of that name, in the order they came', ()=>{
    const { table } = setup();
    const first = record('bar.dll', 0x10000000, { fromFile: true, path: 'C:\\App\\bar.dll' });
    const second = record('bar.dll', 0x20000000,
        { fromFile: true, path: 'C:\\Windows\\system32\\bar.dll' });
    const third = record('bar.dll', 0x30000000, { fromFile: true, path: 'D:\\bar.dll' });
    table.add(first, 'bar');
    table.add(second, 'bar', 'first');
    table.add(third, 'bar', 'first');
    table.remove(first);
    assert.equal(table.find('bar'), second);
    assert.equal(table.atBase(0x10000000), null);
    table.remove(third);
    assert.equal(table.find('bar'), second, 'a module that did not hold the name leaves it be');
    table.remove(second);
    assert.equal(table.find('bar'), null);
});

test('a module no bare name finds is still there by its base, and the program by no name', ()=>{
    const { table } = setup();
    const face = record('comctl32.dll', 0x30000000);
    const main = record('app', 0x00400000, { path: 'C:\\App\\app.exe' });
    table.add(face, null);
    assert.equal(table.find('comctl32'), null);
    assert.equal(table.atBase(0x30000000 + 2 ** 32), face, 'a base taken as a dword');
    assert.equal(table.find(null), null);
    table.setMain(main, 'app.exe');
    assert.equal(table.find(null), main);
    assert.equal(table.find(''), main);
    assert.equal(table.find('app.exe'), main);
    assert.equal(table.containing(0x00400123), main);
    assert.equal(table.containing(0x00410000), null, 'past its size');
    assert.deepEqual([...table.all()], [face, main], 'in the order they came');
});

test('a module marked loaded brings in what it imports, each told once, and lists as loaded', ()=>{
    const { table, told } = setup({ kernel32: ['ntdll'], user32: ['kernel32', 'gdi32'] });
    for (const [name, base] of /** @type {const} */ ([['ntdll', 1], ['kernel32', 2],
        ['gdi32', 3], ['user32', 4], ['ole32', 5]]))
    {
        table.add(record(`${name}.dll`, base * 0x1000000, { loaded: false }), name);
    }
    table.markLoaded(table.named('user32'));
    assert.deepEqual(told, ['user32.dll', 'kernel32.dll', 'ntdll.dll', 'gdi32.dll']);
    table.markLoaded(table.named('kernel32'));
    assert.equal(told.length, 4, 'a loaded module is not told again');
    assert.deepEqual(table.loaded().map(module=>module.name),
        ['ntdll.dll', 'kernel32.dll', 'gdi32.dll', 'user32.dll']);
    assert.equal(table.named('ole32')?.loaded, false);
});
