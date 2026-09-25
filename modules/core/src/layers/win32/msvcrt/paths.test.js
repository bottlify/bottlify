/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPathFunctions, splitPath, fullPath } from './paths.js';
import { fakeMemory } from './harness.test.js';

/** A volume with the handful of operations the path functions reach for. */
function fakeVolume(existing = ['C:\\game', 'C:\\game\\data.mpq']){
    const entries = new Set(existing);
    let current = 'C:\\game';
    return {
        entries,
        stat: (/** @type {string} */ path)=>({ exists: entries.has(path) }),
        remove(/** @type {string} */ path){
            return entries.delete(path);
        },
        rename(/** @type {string} */ from, /** @type {string} */ to){
            if (!entries.delete(from))
            {
                return false;
            }
            entries.add(to);
            return true;
        },
        mkdir(/** @type {string} */ path){
            if (entries.has(path))
            {
                return false;
            }
            entries.add(path);
            return true;
        },
        currentDirectory: ()=>current,
        setCurrentDirectory(/** @type {string} */ path){
            current = path;
        },
    };
}

const build = ()=>{
    const memory = fakeMemory();
    const files = fakeVolume();
    return {
        memory,
        files,
        table: /** @type {Record<string, any>} */ (createPathFunctions({ ...memory, files })),
    };
};

test('a path splits at the colon, the last separator and the last dot', ()=>{
    assert.deepEqual(splitPath('C:\\game\\war.exe'),
        { drive: 'C:', directory: '\\game\\', name: 'war', extension: '.exe' });
    assert.deepEqual(splitPath('data/sound.wav'),
        { drive: '', directory: 'data/', name: 'sound', extension: '.wav' });
    assert.deepEqual(splitPath('readme'),
        { drive: '', directory: '', name: 'readme', extension: '' });
});

test('a leading dot is a name, not an empty extension', ()=>{
    assert.deepEqual(splitPath('.config'),
        { drive: '', directory: '', name: '.config', extension: '' });
});

test('only the last dot separates the extension', ()=>{
    const parts = splitPath('archive.tar.gz');
    assert.equal(parts.name, 'archive.tar');
    assert.equal(parts.extension, '.gz');
});

test('_splitpath writes only the pieces the caller asked for', ()=>{
    const { memory, table } = build();
    const name = memory.allocate(64);
    const extension = memory.allocate(64);
    table._splitpath.handler([memory.put('C:\\game\\war.exe'), 0, 0, name, extension]);
    assert.equal(memory.text(name), 'war');
    assert.equal(memory.text(extension), '.exe');
});

test('_makepath supplies the separators the caller left out', ()=>{
    const { memory, table } = build();
    const path = memory.allocate(128);
    table._makepath.handler([path, memory.put('C'), memory.put('\\game'),
        memory.put('war'), memory.put('exe')]);
    assert.equal(memory.text(path), 'C:\\game\\war.exe');
});

test('_makepath leaves separators that are already there', ()=>{
    const { memory, table } = build();
    const path = memory.allocate(128);
    table._makepath.handler([path, memory.put('C:'), memory.put('\\game\\'),
        memory.put('war'), memory.put('.exe')]);
    assert.equal(memory.text(path), 'C:\\game\\war.exe');
});

test('a relative path resolves against the working directory', ()=>{
    assert.equal(fullPath('data\\x.mpq', 'C:\\game'), 'C:\\game\\data\\x.mpq');
    assert.equal(fullPath('\\rooted', 'C:\\game'), 'C:\\rooted');
    assert.equal(fullPath('D:\\other', 'C:\\game'), 'D:\\other');
});

test('dot and double dot are flattened, and the root is the floor', ()=>{
    assert.equal(fullPath('.\\a\\..\\b', 'C:\\game'), 'C:\\game\\b');
    assert.equal(fullPath('..\\..\\..\\..\\x', 'C:\\game'), 'C:\\x');
});

test('_fullpath allocates when handed a null buffer, and refuses a short one', ()=>{
    const { memory, table } = build();
    const allocated = table._fullpath.handler([0, memory.put('data'), 0]);
    assert.equal(memory.text(allocated), 'C:\\game\\data');
    assert.equal(table._fullpath.handler([memory.allocate(64), memory.put('data'), 4]), 0);
});

test('_getcwd fills the buffer and answers it', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(64);
    assert.equal(table._getcwd.handler([buffer, 64]), buffer);
    assert.equal(memory.text(buffer), 'C:\\game');
});

test('_getcwd with no buffer allocates at least the size it was given', ()=>{
    // "A buffer of at least size maxlen (more only if necessary)": a caller
    // that passes 260 appends a file name to the directory in place, into the
    // room it asked for.
    const memory = fakeMemory();
    /** @type {number[]} */
    const sizes = [];
    const table = /** @type {Record<string, any>} */ (createPathFunctions({
        ...memory,
        files: fakeVolume(),
        allocate: (/** @type {number} */ bytes)=>{
            sizes.push(bytes);
            return memory.allocate(bytes);
        },
    }));

    const roomy = table._getcwd.handler([0, 260]);
    assert.equal(memory.text(roomy), 'C:\\game');
    assert.equal(sizes.at(-1), 260);

    table._getcwd.handler([0, 0]);
    assert.equal(sizes.at(-1), 'C:\\game'.length + 1, 'and never less than the path needs');
});

test('the operations answer zero for success and -1 for failure', ()=>{
    const { memory, files, table } = build();
    assert.equal(table._chdir.handler([memory.put('C:\\game')]), 0);
    assert.equal(table._chdir.handler([memory.put('C:\\nowhere')]), -1);
    assert.equal(table._mkdir.handler([memory.put('C:\\new')]), 0);
    assert.equal(table._mkdir.handler([memory.put('C:\\new')]), -1, 'it exists already');
    assert.ok(files.entries.has('C:\\new'));
});

test('remove and rename act on the volume, and _access asks whether it exists', ()=>{
    const { memory, files, table } = build();
    assert.equal(table._access.handler([memory.put('C:\\game\\data.mpq'), 0]), 0);
    assert.equal(table.rename.handler(
        [memory.put('C:\\game\\data.mpq'), memory.put('C:\\game\\old.mpq')]), 0);
    assert.equal(table._access.handler([memory.put('C:\\game\\data.mpq'), 0]), -1);
    assert.equal(table.remove.handler([memory.put('C:\\game\\old.mpq')]), 0);
    assert.equal(files.entries.has('C:\\game\\old.mpq'), false);
});

test('_getdrives reports C and nothing else', ()=>{
    assert.equal(build().table._getdrives.handler([]), 0b100);
});
