/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShlwapiFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

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
