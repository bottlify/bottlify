/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPathFunctions, splitPath, fullPath } from './paths.js';
import { fakeMemory, fakeVolume as fakeFiles } from './harness.test.js';

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

test('a failing operation says why in errno, as each one documents', ()=>{
    const memory = fakeMemory();
    const files = fakeVolume(['C:\\game', 'C:\\game\\data.mpq', 'C:\\game\\saves']);
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createPathFunctions({
        ...memory, files, errno: code=>errno.push(code),
    }));
    const ENOENT = 2;
    const EACCES = 13;
    const EEXIST = 17;
    const ERANGE = 34;
    const ENOTEMPTY = 41;
    /** @param {string} name @param {number[]} args */
    const fails = (name, ...args)=>{
        const answer = table[name].handler(args);
        return [answer, errno.pop()];
    };

    assert.deepEqual(fails('_getcwd', memory.allocate(4), 4), [0, ERANGE], 'the path is longer');
    assert.deepEqual(fails('_chdir', memory.put('C:\\nowhere')), [-1, ENOENT]);
    assert.deepEqual(fails('_mkdir', memory.put('C:\\game\\saves')), [-1, EEXIST]);
    files.mkdir = ()=>false;
    assert.deepEqual(fails('_mkdir', memory.put('C:\\gone\\saves')), [-1, ENOENT],
        'the directory above is missing');
    assert.deepEqual(fails('_unlink', memory.put('C:\\game\\none.txt')), [-1, ENOENT]);
    assert.deepEqual(fails('remove', memory.put('C:\\game\\none.txt')), [-1, ENOENT]);
    assert.deepEqual(fails('_rmdir', memory.put('C:\\game\\none')), [-1, ENOENT]);
    assert.deepEqual(fails('rename', memory.put('C:\\game\\none.txt'), memory.put('C:\\x')),
        [-1, ENOENT], 'the old name is not there');
    assert.deepEqual(fails('_access', memory.put('C:\\game\\none.txt'), 0), [-1, ENOENT]);

    // What is there and still refused: the volume declines, and the name
    // exists, so it is not a missing path.
    files.remove = ()=>false;
    files.rename = ()=>false;
    assert.deepEqual(fails('_unlink', memory.put('C:\\game\\data.mpq')), [-1, EACCES]);
    assert.deepEqual(fails('remove', memory.put('C:\\game\\data.mpq')), [-1, EACCES]);
    assert.deepEqual(fails('_rmdir', memory.put('C:\\game\\saves')), [-1, ENOTEMPTY]);
    assert.deepEqual(fails('rename', memory.put('C:\\game\\data.mpq'), memory.put('C:\\game')),
        [-1, EACCES]);
    assert.deepEqual(errno, [], 'nothing else was set');

    assert.equal(table._chdir.handler([memory.put('C:\\game')]), 0);
    assert.deepEqual(errno, [], 'and success leaves errno alone');
});

test('_getdrives reports C and nothing else', ()=>{
    assert.equal(build().table._getdrives.handler([]), 0b100);
});

/** `struct _finddata_t` as msvcrt.dll lays it out: 32-bit times, 260 bytes of name. */
const FIND = { ATTRIB: 0, CREATE: 4, ACCESS: 8, WRITE: 12, SIZE: 16, NAME: 20, BYTES: 280 };

function finder(){
    const memory = fakeMemory();
    const written = Date.UTC(2003, 6, 1);
    const files = fakeFiles({
        'C:\\game\\a.dat': new Uint8Array(3),
        'C:\\game\\b.dat': new Uint8Array(5),
        'C:\\game\\readme.txt': new Uint8Array(1),
    }, { directories: ['C:\\', 'C:\\game', 'C:\\game\\maps'], modified: written });
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createPathFunctions({
        ...memory, files, errno: code=>errno.push(code),
    }));
    const data = memory.allocate(FIND.BYTES);
    const found = ()=>{
        const view = new DataView(memory.bytes.buffer, data, FIND.BYTES);
        return {
            name: memory.text(data + FIND.NAME),
            attrib: view.getUint32(FIND.ATTRIB, true),
            size: view.getUint32(FIND.SIZE, true),
            times: [FIND.CREATE, FIND.ACCESS, FIND.WRITE].map(at=>view.getUint32(at, true)),
        };
    };
    return { memory, table, errno, data, found, written };
}

test('_findfirst and _findnext walk what matches, and -1 with ENOENT ends the walk', ()=>{
    const { memory, table, errno, data, found, written } = finder();
    const handle = table._findfirst.handler([memory.put('C:\\game\\*.dat'), data]);
    assert.notEqual(handle, -1);
    assert.deepEqual(found(), {
        name: 'a.dat', attrib: 0x20, size: 3, times: Array(3).fill(written / 1000),
    }, 'an archive-flagged file, as FindFirstFile reports it');
    assert.equal(table._findnext.handler([handle, data]), 0);
    assert.equal(found().name, 'b.dat');
    assert.equal(table._findnext.handler([handle, data]), -1);
    assert.deepEqual(errno.splice(0), [2]);
    assert.equal(table._findclose.handler([handle]), 0);
    assert.equal(table._findclose.handler([handle]), -1, 'closed already');
    assert.equal(table._findnext.handler([handle, data]), -1);
    assert.deepEqual(errno.splice(0), [9, 2]);
});

test('_findfirst finds a directory by its name and says it is one', ()=>{
    const { memory, table, data, found } = finder();
    const handle = table._findfirst.handler([memory.put('C:\\game\\maps'), data]);
    assert.notEqual(handle, -1);
    assert.deepEqual([found().name, found().attrib], ['maps', 0x10]);
    assert.equal(table._findfirst.handler([memory.put('C:\\*.*'), data]) === -1, false,
        'the root, its separator kept');
    assert.equal(found().name, 'game');
});

test('_findfirst with nothing to match is -1 and ENOENT, and a null name EINVAL', ()=>{
    const { memory, table, errno, data } = finder();
    assert.equal(table._findfirst.handler([memory.put('C:\\game\\*.exe'), data]), -1);
    assert.equal(table._findfirst.handler([memory.put('C:\\none\\*.dat'), data]), -1);
    assert.equal(table._findfirst.handler([memory.put('C:\\game\\'), data]), -1);
    assert.equal(table._findfirst.handler([0, data]), -1);
    assert.deepEqual(errno, [2, 2, 2, 22]);
    assert.deepEqual([table._findfirst.argBytes, table._findnext.argBytes,
        table._findclose.argBytes], [8, 8, 4]);
});

/** `struct _finddatai64_t` as msvcrt.dll lays it out: 32-bit times, the size 8-aligned. */
const FIND64 = { ATTRIB: 0, CREATE: 4, ACCESS: 8, WRITE: 12, SIZE: 16, NAME: 24, BYTES: 288 };

test('_findfirsti64 and _findnexti64 walk the same way into the 64-bit record', ()=>{
    const { memory, table, errno, written } = finder();
    const data = memory.allocate(FIND64.BYTES);
    memory.writeMemory(data, new Uint8Array(FIND64.BYTES).fill(0xcc));
    const view = new DataView(memory.bytes.buffer, data, FIND64.BYTES);

    const handle = table._findfirsti64.handler([memory.put('C:\\game\\*.dat'), data]);
    assert.notEqual(handle, -1);
    assert.equal(memory.text(data + FIND64.NAME), 'a.dat');
    assert.equal(view.getUint32(FIND64.ATTRIB, true), 0x20);
    assert.deepEqual([FIND64.CREATE, FIND64.ACCESS, FIND64.WRITE].map(at=>view.getUint32(at, true)),
        Array(3).fill(written / 1000));
    assert.equal(view.getBigUint64(FIND64.SIZE, true), 3n);
    assert.equal(view.getUint8(FIND64.BYTES - 1), 0, 'the whole record is written');

    assert.equal(table._findnexti64.handler([handle, data]), 0);
    assert.equal(memory.text(data + FIND64.NAME), 'b.dat');
    assert.equal(view.getBigUint64(FIND64.SIZE, true), 5n);
    assert.equal(table._findnexti64.handler([handle, data]), -1);
    assert.equal(table._findclose.handler([handle]), 0, 'one _findclose for both');
    assert.equal(table._findfirsti64.handler([memory.put('C:\\game\\*.exe'), data]), -1);
    assert.deepEqual(errno, [2, 2]);
    assert.deepEqual([table._findfirsti64.argBytes, table._findnexti64.argBytes], [8, 8]);
});

/** `struct _wfinddatai64_t`: the same, with 260 wide characters of name. */
const WFIND64 = { ATTRIB: 0, CREATE: 4, SIZE: 16, NAME: 24, BYTES: 544 };

test('_wfindfirsti64 and _wfindnexti64 take a wide pattern and write wide names', ()=>{
    const { memory, table, errno, written } = finder();
    const data = memory.allocate(WFIND64.BYTES);
    memory.writeMemory(data, new Uint8Array(WFIND64.BYTES).fill(0xcc));
    const view = new DataView(memory.bytes.buffer, data, WFIND64.BYTES);

    const handle = table._wfindfirsti64.handler([memory.putWide('C:\\game\\*.dat'), data]);
    assert.notEqual(handle, -1);
    assert.equal(memory.wide(data + WFIND64.NAME), 'a.dat');
    assert.equal(view.getUint32(WFIND64.ATTRIB, true), 0x20);
    assert.equal(view.getUint32(WFIND64.CREATE, true), written / 1000);
    assert.equal(view.getBigUint64(WFIND64.SIZE, true), 3n);
    assert.equal(view.getUint8(WFIND64.BYTES - 1), 0, 'the whole record is written');

    assert.equal(table._wfindnexti64.handler([handle, data]), 0);
    assert.equal(memory.wide(data + WFIND64.NAME), 'b.dat');
    assert.equal(view.getBigUint64(WFIND64.SIZE, true), 5n);
    assert.equal(table._wfindnexti64.handler([handle, data]), -1);
    assert.equal(table._findclose.handler([handle]), 0);
    assert.equal(table._wfindfirsti64.handler([memory.putWide('C:\\game\\*.exe'), data]), -1);
    assert.equal(table._wfindfirsti64.handler([0, data]), -1);
    assert.deepEqual(errno, [2, 2, 22]);
    assert.deepEqual([table._wfindfirsti64.argBytes, table._wfindnexti64.argBytes], [8, 8]);
});

/** `struct _wfinddata_t`: `_finddata_t` with 260 wide characters of name. */
const WFIND = { ATTRIB: 0, CREATE: 4, SIZE: 16, NAME: 20, BYTES: 540 };

test('_wfindfirst and _wfindnext take a wide pattern and write the 32-bit record', ()=>{
    // "The fields of this data type are the same as the fields of the
    // _finddata_t data type, except that in _wfinddata_t the name field is of
    // type wchar_t instead of type char."
    const { memory, table, errno, written } = finder();
    const data = memory.allocate(WFIND.BYTES);
    memory.writeMemory(data, new Uint8Array(WFIND.BYTES).fill(0xcc));
    const view = new DataView(memory.bytes.buffer, data, WFIND.BYTES);

    const handle = table._wfindfirst.handler([memory.putWide('C:\\game\\*.dat'), data]);
    assert.notEqual(handle, -1);
    assert.equal(memory.wide(data + WFIND.NAME), 'a.dat');
    assert.equal(view.getUint32(WFIND.ATTRIB, true), 0x20);
    assert.equal(view.getUint32(WFIND.CREATE, true), written / 1000);
    assert.equal(view.getUint32(WFIND.SIZE, true), 3);
    assert.equal(view.getUint8(WFIND.BYTES - 1), 0, 'the whole record is written');

    assert.equal(table._wfindnext.handler([handle, data]), 0);
    assert.equal(memory.wide(data + WFIND.NAME), 'b.dat');
    assert.equal(view.getUint32(WFIND.SIZE, true), 5);
    assert.equal(table._wfindnext.handler([handle, data]), -1);
    assert.equal(table._findclose.handler([handle]), 0);
    assert.equal(table._wfindfirst.handler([memory.putWide('C:\\game\\*.exe'), data]), -1);
    assert.equal(table._wfindfirst.handler([0, data]), -1);
    assert.deepEqual(errno, [2, 2, 22]);
    assert.deepEqual([table._wfindfirst.argBytes, table._wfindnext.argBytes], [8, 8]);
});

test('_findfirsti64 reports a size past 4 GiB whole', ()=>{
    const memory = fakeMemory();
    const big = 5 * 2 ** 30;
    const table = /** @type {Record<string, any>} */ (createPathFunctions({
        ...memory,
        files: {
            stat: ()=>({ exists: true, isDirectory: true, size: 0 }),
            list: ()=>[{ name: 'movie.bik', isDirectory: false, size: big }],
        },
    }));
    const data = memory.allocate(FIND64.BYTES);
    assert.notEqual(table._findfirsti64.handler([memory.put('C:\\game\\*.bik'), data]), -1);
    const view = new DataView(memory.bytes.buffer, data, FIND64.BYTES);
    assert.equal(view.getBigUint64(FIND64.SIZE, true), BigInt(big));
});

test('a path\'s pieces and a found name are written in the ANSI page', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash; what goes back is in
    // the same page, so the pieces of a path are its own bytes, and a file
    // found on the volume is named in the bytes a program would open it by.
    const memory = fakeMemory();
    const table = /** @type {Record<string, any>} */ (createPathFunctions({
        ...memory,
        files: {
            stat: ()=>({ exists: true, isDirectory: true, size: 0 }),
            list: ()=>[{ name: '\u20ac\u2122\u2014\u00e9.dat', isDirectory: false, size: 1 }],
        },
    }));
    const path = memory.allocate(16);
    memory.writeMemory(path,
        Uint8Array.of(0x43, 0x3a, 0x5c, 0x80, 0x5c, 0x99, 0x97, 0x2e, 0x97, 0));
    const directory = memory.allocate(16);
    const name = memory.allocate(16);
    const extension = memory.allocate(16);
    table._splitpath.handler([path, 0, directory, name, extension]);
    assert.deepEqual([...memory.bytes.subarray(directory, directory + 4)], [0x5c, 0x80, 0x5c, 0]);
    assert.deepEqual([...memory.bytes.subarray(name, name + 3)], [0x99, 0x97, 0]);
    assert.deepEqual([...memory.bytes.subarray(extension, extension + 3)], [0x2e, 0x97, 0]);

    const data = memory.allocate(FIND.BYTES);
    assert.notEqual(table._findfirst.handler([memory.put('C:\\game\\*.dat'), data]), -1);
    assert.deepEqual([...memory.bytes.subarray(data + FIND.NAME, data + FIND.NAME + 5)],
        [0x80, 0x99, 0x97, 0xe9, 0x2e]);
});
