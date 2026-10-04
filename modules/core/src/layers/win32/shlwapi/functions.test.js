/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShlwapiFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { createRegistryFunctions } from '../advapi32/functions.js';
import { createHive } from '../advapi32/registry.js';

const AT = 0x100;

function machine(){
    const memory = new Uint8Array(0x400);
    const fns = createShlwapiFunctions({
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    /** @param {string} text */
    const put = text=>{
        memory.fill(0, AT, AT + 0x100);
        memory.set(new TextEncoder().encode(text), AT);
        return AT;
    };
    /** @param {number} address */
    const at = address=>{
        let text = '';
        for (let cursor = address; memory[cursor] !== 0; cursor++)
        {
            text += String.fromCharCode(memory[cursor]);
        }
        return text;
    };
    return { fns, put, at };
}

test('a directory is answered with its attribute, a file and nothing with 0', ()=>{
    // PathIsDirectory asks the volume, against the current directory as the
    // file functions do; without one every path names nothing.
    const memory = new Uint8Array(0x400);
    /** @type {Record<string, boolean>} */
    const volume = { 'C:\\App': true, 'C:\\App\\Data': true, 'C:\\App\\game.exe': false };
    const fns = createShlwapiFunctions({
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && memory[at] !== 0; at += 2)
            {
                text += String.fromCharCode(memory[at] | memory[at + 1] << 8);
            }
            return text;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        files: { stat: path=>({ exists: path in volume, isDirectory: volume[path] === true }) },
        fullPath: path=>(/^[A-Za-z]:/.test(path) ? path : `C:\\App\\${path}`)
            .replace(/\\+$/, ''),
    });
    /** @param {string} text */
    const put = text=>{
        memory.fill(0, AT, AT + 0x100);
        memory.set(new TextEncoder().encode(text), AT);
        return AT;
    };
    /** @param {string} text */
    const putWide = text=>{
        memory.fill(0, AT, AT + 0x100);
        for (let at = 0; at < text.length; at++)
        {
            memory[AT + at * 2] = text.charCodeAt(at);
        }
        return AT;
    };
    assert.equal(fns.PathIsDirectoryA.handler([put('C:\\App')]), 0x10);
    assert.equal(fns.PathIsDirectoryA.handler([put('Data')]), 0x10,
        'a relative path, against the current directory');
    assert.equal(fns.PathIsDirectoryA.handler([put('C:\\App\\game.exe')]), 0, 'a file');
    assert.equal(fns.PathIsDirectoryA.handler([put('C:\\Missing')]), 0, 'nothing there');
    assert.equal(fns.PathIsDirectoryA.handler([0]), 0, 'no path');
    assert.equal(fns.PathIsDirectoryW.handler([putWide('C:\\App\\Data\\')]), 0x10,
        'the wide spelling, a trailing separator and all');
    assert.equal(fns.PathFindExtensionW.handler([putWide('C:\\dir.d\\file.txt')]), AT + 13 * 2,
        'a wide extension is two bytes a character in');
    assert.equal(fns.PathFindFileNameW.handler([putWide('C:\\dir\\file.exe')]), AT + 7 * 2);
    assert.equal(machine().fns.PathIsDirectoryA.handler([put('C:\\App')]), 0,
        'with no volume, nothing is there');
});

test('a backslash is added once, an empty path is left alone, a long one refused', ()=>{
    const { fns, put, at } = machine();
    assert.equal(fns.PathAddBackslashA.handler([put('C:\\App')]), AT + 7);
    assert.equal(at(AT), 'C:\\App\\');
    assert.equal(fns.PathAddBackslashA.handler([put('C:\\App\\')]), AT + 7, 'already there');
    assert.equal(at(AT), 'C:\\App\\');
    assert.equal(fns.PathAddBackslashA.handler([put('')]), AT, 'nothing to end');
    assert.equal(at(AT), '');
    assert.equal(fns.PathAddBackslashA.handler([put('a'.repeat(260))]), 0, 'MAX_PATH or more');
    assert.equal(at(AT), 'a'.repeat(260), 'and untouched');
    assert.equal(fns.PathAddBackslashA.handler([0]), 0);
});

test('the extension is removed in place, a directory dot and no extension are not', ()=>{
    const { fns, put, at } = machine();
    fns.PathRemoveExtensionA.handler([put('C:\\dir.d\\file.tar.gz')]);
    assert.equal(at(AT), 'C:\\dir.d\\file.tar');
    fns.PathRemoveExtensionA.handler([put('C:\\dir.d\\file')]);
    assert.equal(at(AT), 'C:\\dir.d\\file');
});

test('a URL is unescaped in place or into a buffer with room, and the count says', ()=>{
    const memory = new Uint8Array(0x400);
    const fns = createShlwapiFunctions({
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    /** @param {number} address */
    const text = address=>{
        let out = '';
        for (let at = address; memory[at] !== 0; at++)
        {
            out += String.fromCharCode(memory[at]);
        }
        return out;
    };
    const url = 0x100;
    const out = 0x200;
    const count = 0x300;
    /** @param {string} value */
    const put = value=>{
        memory.fill(0, url, url + 0x100);
        memory.set(new TextEncoder().encode(value), url);
    };
    /** @param {number} value */
    const room = value=>memory.set(Uint8Array.of(value, 0, 0, 0), count);
    const counted = ()=>memory[count] | memory[count + 1] << 8;

    put('a%20b%41c?d%20e');
    room(64);
    assert.equal(fns.UrlUnescapeA.handler([url, out, count, 0]), 0);
    assert.equal(text(out), 'a bAc?d e');
    assert.equal(counted(), 9, 'the characters written');
    room(64);
    assert.equal(fns.UrlUnescapeA.handler([url, out, count, 0x02000000]), 0);
    assert.equal(text(out), 'a bAc?d%20e', 'past ? left as it is');
    room(4);
    assert.equal(fns.UrlUnescapeA.handler([url, out, count, 0]) >>> 0, 0x80004003);
    assert.equal(counted(), 10, 'the room the answer needs, its terminator included');
    put('%2Fx%zz%4');
    assert.equal(fns.UrlUnescapeA.handler([url, 0, 0, 0x00100000]), 0);
    assert.equal(text(url), '/x%zz%4', 'in place; a malformed escape stays');
    assert.equal(fns.UrlUnescapeA.handler([0, out, count, 0]) >>> 0, 0x80070057);
});

test('the extension is the last dot of the last component, or the terminator', ()=>{
    const { fns, put, at } = machine();
    assert.equal(at(fns.PathFindExtensionA.handler([put('C:\\dir.d\\file.tar.gz')])), '.gz');
    assert.equal(at(fns.PathFindExtensionA.handler([put('C:\\dir.d\\file')])), '',
        'a dot in a directory name is not the file\'s extension');
    assert.equal(fns.PathFindExtensionA.handler([put('file.txt')]), AT + 4,
        'a pointer into the caller\'s own buffer');
    assert.equal(fns.PathFindExtensionA.handler([0]), 0);
});

test('the file name follows the last separator that has something after it', ()=>{
    const { fns, put, at } = machine();
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:\\dir\\file.exe')])), 'file.exe');
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:\\dir\\')])), 'dir\\');
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:file')])), 'file');
    assert.equal(at(fns.PathFindFileNameA.handler([put('file')])), 'file');
});

test('stripping to the root keeps a drive or a share and refuses a path with neither', ()=>{
    const { fns, put, at } = machine();
    let path = put('C:\\Program Files\\Title\\title.exe');
    assert.equal(fns.PathStripToRootA.handler([path]), 1);
    assert.equal(at(path), 'C:\\');

    path = put('\\\\server\\share\\dir\\file');
    assert.equal(fns.PathStripToRootA.handler([path]), 1);
    assert.equal(at(path), '\\\\server\\share');

    path = put('dir\\file');
    assert.equal(fns.PathStripToRootA.handler([path]), 0);
    assert.equal(at(path), '', 'cut down one component at a time until nothing was left');
});

test('a UNC path is one that starts with two separators', ()=>{
    const { fns, put } = machine();
    assert.equal(fns.PathIsUNCA.handler([put('\\\\server\\share')]), 1);
    assert.equal(fns.PathIsUNCA.handler([put('C:\\dir')]), 0);
    assert.equal(fns.PathIsUNCA.handler([put('\\')]), 0);
    assert.equal(fns.PathIsUNCA.handler([0]), 0);
});

/** Memory with room for several strings of either width at once. */
function strings(){
    const memory = new Uint8Array(0x40000);
    let next = 0x100;
    const view = new DataView(memory.buffer);
    const fns = /** @type {any} */ (createShlwapiFunctions({
        // As the memory layer reads an ANSI string: in Windows-1252, which is
        // what the Encoding standard calls latin1.
        readCString: (address, maxLength)=>{
            let end = address;
            while (end < address + maxLength && memory[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength * 2; at += 2)
            {
                const unit = view.getUint16(at, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    }));
    /** @param {string} text @param {boolean} [wide] @param {number} [room] */
    const put = (text, wide = false, room = 0x200)=>{
        const at = next;
        next += Math.max(room, (text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            if (wide)
            {
                view.setUint16(at + index * 2, text.charCodeAt(index), true);
            }
            else
            {
                memory[at + index] = text.charCodeAt(index);
            }
        }
        return at;
    };
    /** @param {number} address @param {boolean} [wide] */
    const read = (address, wide = false)=>{
        let text = '';
        for (let at = address; ; at += wide ? 2 : 1)
        {
            const unit = wide ? view.getUint16(at, true) : memory[at];
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
    };
    return { fns, memory, view, put, read };
}

test('PathCombineA gives the path back in the bytes its pieces had', ()=>{
    // The pieces are read as Windows-1252, where 0x80 is the euro sign, 0x99
    // the trade mark and 0x97 an em dash, and the path is written in that page.
    const { fns, memory, put } = strings();
    const dest = put('');
    assert.equal(fns.PathCombineA.handler([dest, put('C:\\\x80'), put('\x99\x97.txt')]), dest);
    assert.deepEqual([...memory.subarray(dest, dest + 11)],
        [0x43, 0x3a, 0x5c, 0x80, 0x5c, 0x99, 0x97, 0x2e, 0x74, 0x78, 0x74]);
    assert.equal(memory[dest + 11], 0);
});

test('PathCombine joins a directory and a file and canonicalises the result', ()=>{
    // shlwapi's path tests, test_PathCombineA.
    const { fns, put, read } = strings();
    /** @param {string | null} dir @param {string | null} file */
    const combine = (dir, file)=>{
        const dest = put('control');
        const answer = fns.PathCombineA.handler([dest,
            dir === null ? 0 : put(dir), file === null ? 0 : put(file)]);
        return {
            answer: answer === 0 ? null : answer === dest ? 'dest' : answer,
            text: read(dest),
        };
    };
    assert.equal(fns.PathCombineA.handler([0, put('C:\\'), put('one\\two\\three')]), 0,
        'no destination');
    assert.deepEqual(combine('C:\\', null), { answer: 'dest', text: 'C:\\' });
    assert.deepEqual(combine('C:\\', ''), { answer: 'dest', text: 'C:\\' });
    assert.deepEqual(combine('', ''), { answer: 'dest', text: '\\' });
    assert.deepEqual(combine(null, 'one\\two\\three'), { answer: 'dest', text: 'one\\two\\three' });
    assert.deepEqual(combine(null, ''), { answer: 'dest', text: '\\' });
    assert.deepEqual(combine(null, null), { answer: null, text: '' });
    assert.deepEqual(combine('C:', 'one\\two\\three'),
        { answer: 'dest', text: 'C:\\one\\two\\three' });
    assert.deepEqual(combine('C:\\', 'one\\two\\three'),
        { answer: 'dest', text: 'C:\\one\\two\\three' });
    assert.deepEqual(combine('C:\\', '\\one\\two\\three'),
        { answer: 'dest', text: 'C:\\one\\two\\three' }, 'a file from the root of the directory');
    assert.deepEqual(combine('C:\\', '\\one\\two\\three\\'),
        { answer: 'dest', text: 'C:\\one\\two\\three\\' });
    assert.deepEqual(combine('relative\\dir', '\\one\\two\\three\\'),
        { answer: 'dest', text: 'one\\two\\three\\' });
    assert.deepEqual(combine('C:\\', 'one/two/three\\'),
        { answer: 'dest', text: 'C:\\one/two/three\\' }, 'a forward slash is not a separator');
    assert.deepEqual(combine('C:\\/\\/', '\\one\\two\\three\\'),
        { answer: 'dest', text: 'C:\\one\\two\\three\\' });
    assert.deepEqual(combine('C:\\', 'one\\..\\two\\.\\three'),
        { answer: 'dest', text: 'C:\\two\\three' });
    assert.deepEqual(combine('C:\\', '..'), { answer: 'dest', text: 'C:\\' },
        'nothing above the root');
    assert.deepEqual(combine('../../../one/two/', '*'),
        { answer: 'dest', text: '../../../one/two/\\*' });
    assert.deepEqual(combine('C:\\dir', 'D:\\other'), { answer: 'dest', text: 'D:\\other' },
        'a file with a drive of its own');
    const long = 'a'.repeat(519);
    assert.deepEqual(combine('C:\\', long), { answer: null, text: '' }, 'longer than MAX_PATH');
    assert.deepEqual(combine(long, 'one\\two\\three'), { answer: null, text: '' });
    assert.deepEqual(combine('b'.repeat(130), 'c'.repeat(130)), { answer: null, text: '' },
        'only the two together are too long');
});

test('PathCombineW is the same join in UTF-16, and may be done in place', ()=>{
    // test_PathCombineW.
    const { fns, put, read } = strings();
    assert.equal(fns.PathCombineW.handler([0, 0, 0]), 0);
    const dest = put('a', true);
    assert.equal(fns.PathCombineW.handler([dest, 0, 0]), 0);
    assert.equal(read(dest, true), '', 'the destination is emptied');
    const first = put(`C:\\${'A'.repeat(126)}`, true);
    const overflow = put('A'.repeat(130), true, 0x400);
    assert.equal(fns.PathCombineW.handler([dest, first, overflow]), 0);
    assert.equal(read(dest, true), '');
    const inPlace = put('C:\\', true);
    assert.equal(fns.PathCombineW.handler([inPlace, inPlace, put('AA', true)]), inPlace);
    assert.equal(read(inPlace, true), 'C:\\AA');
    assert.equal(fns.PathCombineW.handler([dest, put('C:\\Games', true),
        put('Save\\\u00e9t\u00e9.dat', true)]), dest);
    assert.equal(read(dest, true), 'C:\\Games\\Save\\\u00e9t\u00e9.dat', 'UTF-16 kept whole');
});

test('PathMatchSpec matches the whole path against each of a list of masks', ()=>{
    // test_PathMatchSpec, minus the two cases Wine marks as not matching Windows.
    const { fns, put } = strings();
    const file = 'c:\\foo\\bar\\filename.ext';
    /** @param {string} spec */
    const match = spec=>fns.PathMatchSpecA.handler([put(file), put(spec)]);
    /** @param {string} spec */
    const matchWide = spec=>fns.PathMatchSpecW.handler([put(file, true), put(spec, true)]);
    const cases = /** @type {[string, number][]} */ ([
        ['.ext', 0], ['*.ext', 1], ['*.ext ', 0], ['  *.ext', 1], ['* . ext', 0],
        ['*.e?t', 1], ['filename.ext', 0], ['*bar\\filename.ext', 1], [' foo; *.ext', 1],
        ['*.ext;*.bar', 1], ['*bar*', 1], ['*.EXT', 1], ['*.*', 1], ['*.ex', 0],
    ]);
    for (const [spec, expected] of cases)
    {
        assert.equal(match(spec), expected, JSON.stringify(spec));
        assert.equal(matchWide(spec), expected, `W ${JSON.stringify(spec)}`);
    }
    assert.equal(fns.PathMatchSpecA.handler([put('README'), put('*.*')]), 1,
        'a name with no dot is still every file');
    assert.equal(fns.PathMatchSpecA.handler([0, put('*')]), 0);
});

test('a colour goes to hue, luminance and saturation on 0..240 and back', ()=>{
    const { fns, put, view } = strings();
    /** @param {number} rgb */
    const toHls = rgb=>{
        const out = put('', false, 16);
        fns.ColorRGBToHLS.handler([rgb, out, out + 2, out + 4]);
        return [view.getUint16(out, true), view.getUint16(out + 2, true),
            view.getUint16(out + 4, true)];
    };
    // A COLORREF is 0x00BBGGRR.
    assert.deepEqual(toHls(0x0000ff), [0, 120, 240], 'red');
    assert.deepEqual(toHls(0x00ff00), [80, 120, 240], 'green');
    assert.deepEqual(toHls(0xff0000), [160, 120, 240], 'blue');
    assert.deepEqual(toHls(0xffffff), [160, 240, 0], 'white: no hue, reported as 160');
    assert.deepEqual(toHls(0x000000), [160, 0, 0]);
    assert.deepEqual(toHls(0x808080), [160, 120, 0]);
    assert.deepEqual(toHls(0x00ffff), [40, 120, 240], 'yellow');

    assert.equal(fns.ColorHLSToRGB.handler([0, 120, 240]), 0x0000ff);
    assert.equal(fns.ColorHLSToRGB.handler([80, 120, 240]), 0x00ff00);
    assert.equal(fns.ColorHLSToRGB.handler([160, 120, 240]), 0xff0000);
    assert.equal(fns.ColorHLSToRGB.handler([160, 240, 0]), 0xffffff);
    assert.equal(fns.ColorHLSToRGB.handler([0, 0, 0]), 0);
    for (const rgb of [0x123456, 0xabcdef, 0x0080ff, 0x7f7f00])
    {
        const [h, l, s] = toHls(rgb);
        const back = fns.ColorHLSToRGB.handler([h, l, s]);
        for (const shift of [0, 8, 16])
        {
            assert.ok(Math.abs((back >>> shift & 0xff) - (rgb >>> shift & 0xff)) <= 3,
                `0x${rgb.toString(16)} comes back as 0x${back.toString(16)}`);
        }
    }
    // A caller may leave out any of the three.
    fns.ColorRGBToHLS.handler([0x0000ff, 0, 0, 0]);
});

test('each declares the arguments it pops', ()=>{
    const { fns } = machine();
    const table = /** @type {Record<string, { argBytes: number }>} */ (
        /** @type {unknown} */ (fns));
    for (const name of ['PathFindExtensionA', 'PathFindFileNameA', 'PathStripToRootA',
        'PathIsUNCA'])
    {
        assert.equal(table[name].argBytes, 4, name);
    }
    assert.deepEqual(['PathCombineA', 'PathCombineW', 'PathMatchSpecA', 'PathMatchSpecW',
        'ColorHLSToRGB', 'ColorRGBToHLS'].map(name=>table[name]?.argBytes),
    [12, 12, 8, 8, 12, 16]);
});

/**
 * The shell's registry helpers over advapi32's own table, as the system's
 * library calls through to the registry's.
 */
function registryMachine(){
    const memory = new Uint8Array(0x40000);
    const view = new DataView(memory.buffer);
    let next = 0x30000;
    const readCString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>{
        let text = '';
        for (let at = address; at < address + maxLength && memory[at] !== 0; at++)
        {
            text += String.fromCharCode(memory[at]);
        }
        return text;
    };
    const readWideString = (/** @type {number} */ address, /** @type {number} */ maxLength)=>{
        let text = '';
        for (let at = address; at < address + maxLength * 2 && view.getUint16(at, true) !== 0;
            at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    const base = {
        readCString,
        readWideString,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            memory.subarray(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, address),
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        free: ()=>{},
    };
    const registry = createRegistryFunctions({ ...base, hive: createHive() });
    const fns = createShlwapiFunctions({ ...base, advapi32: ()=>registry });
    let argAt = 0x10100;
    /** @param {string} text */
    const str = text=>{
        const at = argAt;
        memory.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        argAt += text.length + 8;
        return at;
    };
    /** @param {string} text */
    const wide = text=>{
        const at = argAt;
        [...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        argAt += text.length * 2 + 8;
        return at;
    };
    const OUT = 0x10000;
    /** @param {string} path */
    const create = path=>{
        assert.equal(registry.RegCreateKeyA.handler([HKEY_CURRENT_USER, str(path), OUT]), 0);
        return view.getUint32(OUT, true);
    };
    /** @param {string} path */
    const exists = path=>{
        const status = registry.RegOpenKeyA.handler([HKEY_CURRENT_USER, str(path), OUT]);
        if (status === 0)
        {
            registry.RegCloseKey.handler([view.getUint32(OUT, true)]);
        }
        return status === 0;
    };
    /** @param {number} key @param {string} name */
    const setValue = (key, name)=>{
        const data = str('x');
        assert.equal(registry.RegSetValueExA.handler([key, str(name), 0, 1, data, 2]), 0);
    };
    return { fns, registry, str, wide, create, exists, setValue };
}

const HKEY_CURRENT_USER = 0x80000001;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_KEY_HAS_CHILDREN = 1020;

test('SHDeleteKey takes a key and everything beneath it', ()=>{
    // Wine's shlwapi test_SHDeleteKey: a key with subkeys and values goes,
    // where RegDeleteKey would refuse it.
    const m = registryMachine();
    const key = m.create('Software\\Test\\Tree');
    m.setValue(key, 'v');
    m.registry.RegCloseKey.handler([key]);
    m.registry.RegCloseKey.handler([m.create('Software\\Test\\Tree\\Child\\Grandchild')]);
    assert.equal(m.fns.SHDeleteKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\Test\\Tree')]),
        0);
    assert.equal(m.exists('Software\\Test\\Tree'), false);
    assert.equal(m.exists('Software\\Test'), true, 'the parent stays');
    assert.equal(m.fns.SHDeleteKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\Test\\Tree')]),
        ERROR_FILE_NOT_FOUND);
    assert.equal(m.fns.SHDeleteKeyA.handler([0x1234, m.str('Software')]), ERROR_INVALID_HANDLE);

    m.registry.RegCloseKey.handler([m.create('Software\\Wide\\Child')]);
    assert.equal(m.fns.SHDeleteKeyW.handler([HKEY_CURRENT_USER, m.wide('Software\\Wide')]), 0);
    assert.equal(m.exists('Software\\Wide'), false);
    assert.equal(m.fns.SHDeleteKeyA.argBytes, 8);
});

test('SHDeleteEmptyKey takes a key only with no subkeys and no values', ()=>{
    const m = registryMachine();
    m.registry.RegCloseKey.handler([m.create('Software\\Empty')]);
    m.registry.RegCloseKey.handler([m.create('Software\\Parent\\Child')]);
    const valued = m.create('Software\\Valued');
    m.setValue(valued, 'v');
    m.registry.RegCloseKey.handler([valued]);

    assert.equal(m.fns.SHDeleteEmptyKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\Parent')]),
        ERROR_KEY_HAS_CHILDREN);
    assert.equal(m.fns.SHDeleteEmptyKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\Valued')]),
        ERROR_KEY_HAS_CHILDREN, 'a value is enough to keep it');
    assert.equal(m.exists('Software\\Parent\\Child'), true);
    assert.equal(m.exists('Software\\Valued'), true);
    assert.equal(m.fns.SHDeleteEmptyKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\Empty')]),
        0);
    assert.equal(m.exists('Software\\Empty'), false);
    assert.equal(m.fns.SHDeleteEmptyKeyW.handler([HKEY_CURRENT_USER,
        m.wide('Software\\Parent\\Child')]), 0);
    assert.equal(m.exists('Software\\Parent\\Child'), false);
    assert.equal(m.fns.SHDeleteEmptyKeyA.handler([HKEY_CURRENT_USER, m.str('Software\\None')]),
        ERROR_FILE_NOT_FOUND);
});

test('SHDeleteValue takes one value of a subkey', ()=>{
    const m = registryMachine();
    const key = m.create('Software\\Values');
    m.setValue(key, 'one');
    m.setValue(key, 'two');
    m.registry.RegCloseKey.handler([key]);
    assert.equal(m.fns.SHDeleteValueA.handler([HKEY_CURRENT_USER, m.str('Software\\Values'),
        m.str('one')]), 0);
    assert.equal(m.fns.SHDeleteValueA.handler([HKEY_CURRENT_USER, m.str('Software\\Values'),
        m.str('one')]), ERROR_FILE_NOT_FOUND);
    assert.equal(m.fns.SHDeleteValueW.handler([HKEY_CURRENT_USER, m.wide('Software\\Values'),
        m.wide('two')]), 0);
    assert.equal(m.fns.SHDeleteValueA.handler([HKEY_CURRENT_USER, m.str('Software\\Nowhere'),
        m.str('one')]), ERROR_FILE_NOT_FOUND);
    assert.equal(m.fns.SHDeleteValueA.argBytes, 12);
});

test('without a registry the helpers say so rather than pretend', ()=>{
    const { fns } = machine();
    assert.equal(fns.SHDeleteKeyA.handler([HKEY_CURRENT_USER, AT]), 120,
        'ERROR_CALL_NOT_IMPLEMENTED');
});
