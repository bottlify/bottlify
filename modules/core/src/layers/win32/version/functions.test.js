/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVersionFunctions } from './functions.js';
import { WINDOWS_VERSIONS } from '../kernel32/versions.js';

/**
 * Builds a VS_VERSIONINFO block by hand.
 *
 * Every node is a length, a value length, a type, a UTF-16 key, then the value
 * and the children, each padded up to the next dword. The padding is what a
 * reader gets wrong, so the builder puts it in rather than assuming it away.
 */
/**
 * @param {string} key
 * @param {{ value?: Uint8Array, text?: string | null, children?: Uint8Array[] }} [parts]
 */
function node(key, parts = {}){
    const { value = new Uint8Array(0), text = null, children = [] } = parts;
    const keyBytes = [...key]
        .flatMap(character=>[character.charCodeAt(0) & 0xff, character.charCodeAt(0) >> 8])
        .concat([0, 0]);

    const body = text === null
        ? [...value]
        : [...text].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])
            .concat([0, 0]);
    const valueLength = text === null ? body.length : body.length / 2;

    const beforeValue = 6 + keyBytes.length;
    const pad = (beforeValue + 3 & ~3) - beforeValue;
    const afterValue = beforeValue + pad + body.length;
    const childPad = (afterValue + 3 & ~3) - afterValue;

    const kids = children.flatMap(child=>[...child]);
    const length = afterValue + childPad + kids.length;

    return new Uint8Array([
        length & 0xff, length >> 8 & 0xff,
        valueLength & 0xff, valueLength >> 8 & 0xff,
        text === null ? 0 : 1, 0,
        ...keyBytes,
        ...new Array(pad).fill(0),
        ...body,
        ...new Array(childPad).fill(0),
        ...kids,
    ]);
}

/**
 * VS_FIXEDFILEINFO, with trailing bytes the node counts and the query must not.
 *
 * Real blocks do carry a value longer than the structure, and a query that
 * reported the node's own length would hand the caller more than it can copy.
 */
function fixedInfo(){
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xfeef04bd, true);
    view.setUint32(8, 1 << 16 | 26, true); // dwFileVersionMS
    view.setUint32(12, 0, true);
    return bytes;
}

function block(){
    return node('VS_VERSION_INFO', {
        value: fixedInfo(),
        children: [
            node('StringFileInfo', {
                children: [node('040904b0', {
                    children: [
                        node('ProductName', { text: 'A Program' }),
                        node('FileVersion', {
                            text: '1.26',
                            // Unusual but legal, and the only shape in which
                            // "characters, not bytes" decides where to look.
                            children: [node('Nested', { text: 'here' })],
                        }),
                    ],
                })],
            }),
            node('VarFileInfo', {
                children: [node('Translation', {
                    value: new Uint8Array([0x09, 0x04, 0xb0, 0x04]),
                })],
            }),
        ],
    });
}

/** @param {Uint8Array | null} resource */
function machine(resource = block()){
    const memory = new Uint8Array(0x2000);
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>
            memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
        readCString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; memory[at] !== 0 && at < memory.length; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        readWideString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; (memory[at] | memory[at + 1]) !== 0 && at < memory.length; at += 2)
            {
                text += String.fromCharCode(memory[at] | memory[at + 1] << 8);
            }
            return text;
        },
        setLastError: ()=>{},
        versionInfo: ()=>resource,
    };
    /** @param {number} at @param {string} text */
    const putString = (at, text)=>{
        memory.set(new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        memory.set(new Uint8Array([...text].flatMap(c=>[c.charCodeAt(0) & 0xff,
            c.charCodeAt(0) >> 8]).concat([0, 0])), at);
    };
    /** @param {number} at */
    const readString = at=>{
        let text = '';
        for (let step = at; memory[step] !== 0; step++)
        {
            text += String.fromCharCode(memory[step]);
        }
        return text;
    };
    const get32 = (/** @type {number} */ at)=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;
    return { memory, host, putString, putWide, readString, get32,
        version: /** @type {any} */ (createVersionFunctions(host)) };
}

/** What GetFileVersionInfoSize answers: the block, a mark, and half again for ANSI. */
const ROOMY = block().length + 4 + Math.ceil(block().length / 2);

test('the size reported is the resource and room for its ANSI answers, and zero for none', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    assert.equal(m.version.GetFileVersionInfoSizeA.handler([0x10, 0x20]), ROOMY);
    assert.equal(m.get32(0x20), 0, 'the handle is documented as zero, and written');

    const empty = machine(null);
    empty.putString(0x10, 'C:\\thing.exe');
    assert.equal(empty.version.GetFileVersionInfoSizeA.handler([0x10, 0]), 0,
        'a file with no version information is ordinary, not an error');
});

test('GetFileVersionInfoSizeA tells a missing file from one with no version resource', ()=>{
    const memory = new Uint8Array(0x2000);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>memory.set(
        new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    const files = /** @type {any} */ (fakeFiles());
    files.nodes.set('C:\\present.exe', Uint8Array.from([1]));
    /** @type {number[]} */
    const errors = [];
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readCString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; memory[at] !== 0 && at < memory.length; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        setLastError: (/** @type {number} */ code)=>errors.push(code),
        files,
    };
    const version = /** @type {any} */ (createVersionFunctions(host));

    put(0x10, 'C:\\missing.exe');
    assert.equal(version.GetFileVersionInfoSizeA.handler([0x10, 0]), 0);
    assert.deepEqual(errors, [2], 'ERROR_FILE_NOT_FOUND: the file itself is not there');

    errors.length = 0;
    put(0x10, 'C:\\present.exe');
    assert.equal(version.GetFileVersionInfoSizeA.handler([0x10, 0]), 0);
    assert.deepEqual(errors, [1812],
        'ERROR_RESOURCE_DATA_NOT_FOUND: present, but carries no version resource');
});

test('a system library the engine answers for has the version of the system it belongs to',
    ()=>{
        // info.c: GetFileVersionInfoSizeA("kernel32.dll") is not zero, and a
        // block copied from it answers the root and the translation. Here
        // kernel32 is a table, not a file, and so is DirectX's ddraw -- which
        // carries the DirectX version the registry reports.
        const memory = new Uint8Array(0x4000);
        /** @type {number[]} */
        const errors = [];
        const files = /** @type {any} */ (fakeFiles());
        const view = new DataView(memory.buffer);
        const version = /** @type {any} */ (createVersionFunctions({
            readMemory: (a, n)=>memory.slice(a, a + n),
            writeMemory: (a, b)=>memory.set(b, a),
            readCString: a=>{
                let text = '';
                for (let at = a; memory[at] !== 0; at++)
                {
                    text += String.fromCharCode(memory[at]);
                }
                return text;
            },
            setLastError: code=>errors.push(code),
            versionInfo: ()=>null,
            files,
            systemLibrary: name=>['kernel32.dll', 'ddraw.dll'].includes(name.toLowerCase()),
        }));
        /** @param {string} path @param {number} [at] */
        const put = (path, at = 0x10)=>{
            memory.set([...path].map(c=>c.charCodeAt(0)).concat([0]), at);
            return at;
        };
        /** @param {string} query */
        const ask = query=>{
            assert.equal(version.VerQueryValueA.handler([0x400, put(query, 0x300), 0x30, 0x34]), 1,
                query);
            return { at: view.getUint32(0x30, true), size: view.getUint32(0x34, true) };
        };
        /** @param {number} at */
        const text = at=>String.fromCharCode(...memory.subarray(at, memory.indexOf(0, at)));

        for (const [path, ms, ls, spelled] of /** @type {[string, number, number, string][]} */ ([
            ['kernel32.dll', 5 << 16 | 1, 2600 << 16 | 0, '5.1.2600.0'],
            ['KERNEL32', 5 << 16 | 1, 2600 << 16 | 0, '5.1.2600.0'],
            ['C:\\WINDOWS\\system32\\ddraw.dll', 4 << 16 | 9, 0 << 16 | 904, '4.09.00.0904'],
        ]))
        {
            const size = version.GetFileVersionInfoSizeA.handler([put(path), 0]);
            assert.ok(size > 0, `${path} has version information`);
            assert.equal(version.GetFileVersionInfoA.handler([put(path), 0, size, 0x400]), 1);
            const root = ask('\\');
            assert.equal(root.size, 52);
            assert.equal(view.getUint32(root.at, true), 0xfeef04bd);
            const fileVersion = [8, 12].map(offset=>view.getUint32(root.at + offset, true));
            assert.deepEqual(fileVersion, [ms, ls], path);
            const translation = ask('\\VarFileInfo\\Translation');
            assert.equal(view.getUint32(translation.at, true), 0x04b00409, 'US English, UTF-16');
            assert.equal(text(ask('\\StringFileInfo\\040904b0\\FileVersion').at), spelled);
        }
        assert.deepEqual(errors, [], 'no error on the way');

        assert.equal(version.GetFileVersionInfoSizeA.handler([put('C:\\Game\\ddraw.dll'), 0]), 0,
            'not where the system keeps it');
        assert.equal(version.GetFileVersionInfoSizeA.handler([put('notalibrary.dll'), 0]), 0);
        assert.deepEqual(errors, [2, 2], 'ERROR_FILE_NOT_FOUND, as for any file not there');
    });

test('a system library carries the version of the Windows the machine is', ()=>{
    // The file's own version, which is the truth even where GetVersionEx is
    // told to answer an older Windows.
    for (const windows of Object.values(WINDOWS_VERSIONS))
    {
        const memory = new Uint8Array(0x4000);
        const view = new DataView(memory.buffer);
        const version = /** @type {any} */ (createVersionFunctions({
            readMemory: (a, n)=>memory.slice(a, a + n),
            writeMemory: (a, b)=>memory.set(b, a),
            readCString: a=>String.fromCharCode(...memory.subarray(a, memory.indexOf(0, a))),
            setLastError: ()=>{},
            versionInfo: ()=>null,
            files: /** @type {any} */ (fakeFiles()),
            systemLibrary: name=>name.toLowerCase() === 'kernel32.dll',
            windows,
        }));
        memory.set([...'kernel32.dll'].map(c=>c.charCodeAt(0)).concat([0]), 0x10);
        memory.set([...'\\'].map(c=>c.charCodeAt(0)).concat([0]), 0x20);
        const size = version.GetFileVersionInfoSizeA.handler([0x10, 0]);
        assert.equal(version.GetFileVersionInfoA.handler([0x10, 0, size, 0x400]), 1);
        assert.equal(version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
        const root = view.getUint32(0x30, true);
        assert.deepEqual([8, 12].map(offset=>view.getUint32(root + offset, true)),
            [(windows.major << 16 | windows.minor) >>> 0, windows.build << 16 >>> 0], windows.name);
    }
});

test('the block is copied whole, and a short buffer is refused', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    const size = block().length;

    assert.equal(m.version.GetFileVersionInfoA.handler([0x10, 0, size - 1, 0x400]), 0);
    assert.equal(m.version.GetFileVersionInfoA.handler([0x10, 0, size, 0x400]), 1);
    assert.deepEqual(m.memory.slice(0x400, 0x400 + size), block());
});

test('the root query answers with the fixed information, at its own size', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 52, 'always the structure size, not the node value');
    // The pointer is into the caller's own block, not a copy.
    const at = m.get32(0x30);
    assert.ok(at > 0x400 && at < 0x400 + block().length);
    assert.equal(m.get32(at), 0xfeef04bd, 'and it lands on the signature');
    assert.equal(m.get32(at + 8), 1 << 16 | 26);
});

test('a string is found down the tree, in ANSI, and its length is in characters', ()=>{
    // wValueLength counts bytes for a binary value and characters for a text
    // one. A reader that treats them alike halves or doubles every string.
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, ROOMY, 0x400]);
    const before = m.memory.slice(0x400, 0x400 + block().length);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\FileVersion');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 5, '"1.26" and its terminator, in characters');
    const at = m.get32(0x30);
    assert.equal(m.readString(at), '1.26', 'a string an A caller can print');
    assert.ok(at >= 0x400 + block().length && at < 0x400 + ROOMY,
        'in the room behind the block');
    assert.deepEqual(m.memory.slice(0x400, 0x400 + block().length), before,
        'which is left as it was, for the next query to walk');

    m.putString(0x20, '\\StringFileInfo\\040904b0\\ProductName');
    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x40, 0x44]), 1);
    assert.equal(m.readString(m.get32(0x40)), 'A Program');
    assert.equal(m.readString(at), '1.26', 'and one answer does not overwrite another');
});

test('a block copied into only its own size is answered in ANSI in place', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\ProductName');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    const at = m.get32(0x30);
    assert.ok(at > 0x400 && at < 0x400 + block().length);
    assert.equal(m.readString(at), 'A Program');
    assert.equal(m.memory[0x400 + block().length], 0, 'nothing is written past the caller\'s room');
});

test('the W spellings name the file and the path in UTF-16 and answer in it', ()=>{
    const m = machine();
    m.putWide(0x100, 'C:\\thing.exe');
    assert.equal(m.version.GetFileVersionInfoSizeW.handler([0x100, 0]), ROOMY);
    assert.equal(m.version.GetFileVersionInfoW.handler([0x100, 0, ROOMY, 0x400]), 1);
    m.putWide(0x200, '\\StringFileInfo\\040904b0\\FileVersion');

    assert.equal(m.version.VerQueryValueW.handler([0x400, 0x200, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 5);
    const at = m.get32(0x30);
    assert.equal(m.host.readWideString(at), '1.26');
    assert.ok(at < 0x400 + block().length, 'the block\'s own string, where it lies');
    assert.equal(m.version.VerQueryValueW.argBytes, 16);
    assert.equal(m.version.GetFileVersionInfoW.argBytes, 16);
    assert.equal(m.version.GetFileVersionInfoSizeW.argBytes, 8);
});

test('the translation is a binary value, counted in bytes', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\VarFileInfo\\Translation');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 4, 'four bytes, not four characters');
});

test('a child of a text node is found past its characters, not its bytes', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\FileVersion\\Nested');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 1);
    assert.equal(m.get32(0x34), 5, '"here" and its terminator');
});

test('a query for something that is not there fails rather than guessing', ()=>{
    const m = machine();
    m.putString(0x10, 'C:\\thing.exe');
    m.version.GetFileVersionInfoA.handler([0x10, 0, block().length, 0x400]);
    m.putString(0x20, '\\StringFileInfo\\040904b0\\CompanyName');

    assert.equal(m.version.VerQueryValueA.handler([0x400, 0x20, 0x30, 0x34]), 0);
});


/** A minimal filesystem: a flat map of full path to bytes. */
function fakeFiles(){
    /** @type {Map<string, Uint8Array>} */
    const nodes = new Map();
    return {
        nodes,
        /** @param {string} path */
        stat: path=>(nodes.has(path)
            ? { exists: true, isDirectory: false, size: /** @type {any} */ (nodes.get(path)).length }
            : null),
        /** @param {string} path @param {import('../kernel32/files.js').OpenMode} mode */
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
        /** @param {{ path: string }} handle @param {number} offset @param {number} length */
        read(handle, offset, length){
            return /** @type {any} */ (nodes.get(handle.path)).slice(offset, offset + length);
        },
        /** @param {{ path: string }} handle @param {number} offset @param {Uint8Array} bytes */
        write(handle, offset, bytes){
            nodes.set(handle.path, bytes.slice());
            return bytes.length;
        },
        close(){},
    };
}

test('VerFindFileA recommends the program directory, and reports a copy that lives elsewhere', ()=>{
    const memory = new Uint8Array(0x2000);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>memory.set(
        new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    /** @param {number} at */
    const readAt = at=>{
        let text = '';
        for (; memory[at] !== 0; at++)
        {
            text += String.fromCharCode(memory[at]);
        }
        return text;
    };
    const files = /** @type {any} */ (fakeFiles());
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readCString: readAt,
        setLastError: ()=>{},
        files,
    };
    const version = /** @type {any} */ (createVersionFunctions(host));
    put(0x10, 'Game.dll');
    put(0x30, 'C:\\WINDOWS');
    put(0x50, 'C:\\Games\\Doom');
    const CUR = 0x400;
    const CURLEN = 0x500;
    const DEST = 0x600;
    const DESTLEN = 0x700;
    memory.set(new Uint8Array([0x04, 1, 0, 0]), CURLEN);
    memory.set(new Uint8Array([0x04, 1, 0, 0]), DESTLEN);

    // A fresh install: no copy anywhere, so the current directory is empty.
    assert.equal(
        version.VerFindFileA.handler([0, 0x10, 0x30, 0x50, CUR, CURLEN, DEST, DESTLEN]), 0);
    assert.equal(readAt(DEST), 'C:\\Games\\Doom');
    assert.equal(readAt(CUR), '');
    assert.equal(memory[CURLEN], 1, 'the terminator alone');
    assert.equal(memory[DESTLEN], 'C:\\Games\\Doom'.length + 1);

    // A shared file goes to the system directory; a copy in the Windows
    // directory is reported as living somewhere other than the destination.
    files.nodes.set('C:\\WINDOWS\\Game.dll', Uint8Array.from([1]));
    const VFFF_ISSHAREDFILE = 1;
    // The lengths are in/out: the first call left the sizes it needed there.
    memory.set(new Uint8Array([0x04, 1, 0, 0]), CURLEN);
    memory.set(new Uint8Array([0x04, 1, 0, 0]), DESTLEN);
    assert.equal(version.VerFindFileA.handler(
        [VFFF_ISSHAREDFILE, 0x10, 0x30, 0x50, CUR, CURLEN, DEST, DESTLEN]), 1, 'VFF_CURNEDEST');
    assert.equal(readAt(DEST), 'C:\\WINDOWS\\system32');
    assert.equal(readAt(CUR), 'C:\\WINDOWS');

    // A buffer too short is told the length it needed, and given what fits.
    memory.set(new Uint8Array([4, 0, 0, 0]), DESTLEN);
    assert.equal(version.VerFindFileA.handler([0, 0x10, 0x30, 0x50, 0, 0, DEST, DESTLEN]),
        4, 'VFF_BUFFTOOSMALL');
    assert.equal(readAt(DEST), 'C:\\');
    assert.equal(memory[DESTLEN], 'C:\\Games\\Doom'.length + 1);
    assert.equal(version.VerFindFileA.argBytes, 32);
});

test('VerInstallFileA expands a compressed source into the destination directory', ()=>{
    const memory = new Uint8Array(0x2000);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>memory.set(
        new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    const files = /** @type {any} */ (fakeFiles());
    // "abababab" packed the SZDD way: two literals then an eight-byte backref.
    files.nodes.set('C:\\TEMP\\set3.TMP', Uint8Array.from([
        0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33, 0x41, 0, 8, 0, 0, 0,
        0b00000011, 0x61, 0x62, 0xf0, 0xf3,
    ]));
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readCString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; memory[at] !== 0 && at < memory.length; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        setLastError: ()=>{},
        files,
    };
    const version = /** @type {any} */ (createVersionFunctions(host));
    put(0x10, 'set3.TMP');
    put(0x30, 'Setup.dll');
    put(0x50, 'C:\\TEMP');
    put(0x80, 'C:\\TEMP\\isp2.TMP');
    const TMP = 0x400;
    const TMPLEN = 0x500;
    memory.set(new Uint8Array([0x04, 1, 0, 0]), TMPLEN);

    const result = version.VerInstallFileA.handler([0, 0x10, 0x30, 0x50, 0x80, 0, TMP, TMPLEN]);
    assert.equal(result, 0, 'zero is success, and the branch that leaves no temp file');
    assert.equal(new TextDecoder().decode(files.nodes.get('C:\\TEMP\\isp2.TMP\\Setup.dll')),
        'abababab', 'the destination holds the expanded bytes');
    assert.equal(memory[TMP], 0, 'and no temp file was named');

    // A source that is not there is reported as unreadable, not as created.
    // The flag is the documented VIF_CANNOTREADSRC: a caller tests the bits
    // it knows, and 0x40 is VIF_WRITEPROT, a different complaint.
    put(0x10, 'missing.dl_');
    assert.equal(
        version.VerInstallFileA.handler([0, 0x10, 0x30, 0x50, 0x80, 0, TMP, TMPLEN]), 0x10000);
});

test('VerInstallFileA keeps a newer file already in place and says so, unless forced', ()=>{
    const memory = new Uint8Array(0x2000);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>memory.set(
        new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat([0])), at);
    const files = /** @type {any} */ (fakeFiles());
    files.nodes.set('C:\\TEMP\\new.dll', Uint8Array.from([1, 2]));
    files.nodes.set('C:\\SYS\\old.dll', Uint8Array.from([9]));
    files.nodes.set('C:\\SYS\\newer.dll', Uint8Array.from([9]));
    /** @param {number} major */
    const versioned = major=>{
        const info = fixedInfo();
        new DataView(info.buffer).setUint32(8, major << 16, true);
        return node('VS_VERSION_INFO', { value: info });
    };
    /** @type {Record<string, Uint8Array>} */
    const versions = {
        'C:\\TEMP\\new.dll': versioned(10),
        'C:\\SYS\\old.dll': versioned(9),
        'C:\\SYS\\newer.dll': versioned(11),
    };
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readCString: (/** @type {number} */ a)=>{
            let text = '';
            for (let at = a; memory[at] !== 0 && at < memory.length; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        setLastError: ()=>{},
        versionInfo: (/** @type {string} */ path)=>versions[path] ?? null,
        files,
    };
    const version = /** @type {any} */ (createVersionFunctions(host));
    put(0x10, 'new.dll');
    put(0x30, 'old.dll');
    put(0x40, 'newer.dll');
    put(0x50, 'C:\\TEMP');
    put(0x80, 'C:\\SYS');
    const VIF_SRCOLD = 0x4;
    const VIFF_FORCEINSTALL = 0x1;

    assert.equal(version.VerInstallFileA.handler([0, 0x10, 0x30, 0x50, 0x80, 0, 0, 0]), 0,
        'an older one in place is replaced');
    assert.deepEqual([...files.nodes.get('C:\\SYS\\old.dll')], [1, 2]);
    assert.equal(version.VerInstallFileA.handler([0, 0x10, 0x40, 0x50, 0x80, 0, 0, 0]),
        VIF_SRCOLD, 'a newer one is kept');
    assert.deepEqual([...files.nodes.get('C:\\SYS\\newer.dll')], [9]);
    assert.equal(version.VerInstallFileA.handler(
        [VIFF_FORCEINSTALL, 0x10, 0x40, 0x50, 0x80, 0, 0, 0]), 0, 'unless forced');
    assert.deepEqual([...files.nodes.get('C:\\SYS\\newer.dll')], [1, 2]);
});

test('VerInstallFileA without a volume reports it cannot create the file', ()=>{
    const memory = new Uint8Array(0x100);
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        writeMemory: ()=>{},
        readCString: ()=>'x',
        setLastError: ()=>{},
    };
    const version = /** @type {any} */ (createVersionFunctions(host));
    assert.equal(version.VerInstallFileA.handler([0, 0, 0, 0, 0, 0, 0, 0]), 0x800,
        'VIF_CANNOTCREATE by its documented value');
});
