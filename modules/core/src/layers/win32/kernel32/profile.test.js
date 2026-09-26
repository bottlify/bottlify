/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileFunctions } from './profile.js';

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const SECTION = 0x100;
const KEY = 0x140;
const DEFAULT = 0x180;
const FILE = 0x1c0;
const VALUE = 0x200;
const OUT = 0x400;

function fakeMemory(){
    const bytes = new Uint8Array(0x1000);
    return {
        bytes,
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /**
         * As the memory layer reads an ANSI string: in Windows-1252, which is
         * what the Encoding standard calls latin1.
         *
         * @param {number} address @param {number} maxLength
         */
        readCString(address, maxLength){
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
        },
        /** @param {number} address @param {string} text */
        put(address, text){
            for (let i = 0; i < text.length; i++)
            {
                bytes[address + i] = text.charCodeAt(i) & 0xff;
            }
            bytes[address + text.length] = 0;
            return address;
        },
        /** @param {number} address @param {number} count */
        raw: (address, count)=>String.fromCharCode(...bytes.subarray(address, address + count)),
    };
}

/** The slice of the filesystem contract the profile family uses. */
function fakeFiles(){
    /** @type {Map<string, Uint8Array>} */
    const nodes = new Map();
    return {
        nodes,
        /** @param {string} path @param {string} text */
        put: (path, text)=>nodes.set(path,
            Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff)),
        /** @param {string} path */
        text: path=>String.fromCharCode(.../** @type {Uint8Array} */ (nodes.get(path))),
        /** @param {string} path */
        stat: path=>(nodes.has(path)
            ? { exists: true, isDirectory: false,
                size: /** @type {Uint8Array} */ (nodes.get(path)).length }
            : null),
        /** @param {string} path @param {import('./files.js').OpenMode} mode */
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
        read(node, offset, length){
            return /** @type {Uint8Array} */ (nodes.get(node.path)).slice(offset, offset + length);
        },
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const grown = new Uint8Array(offset + bytes.length);
            grown.set(/** @type {Uint8Array} */ (nodes.get(node.path)).subarray(0, offset));
            grown.set(bytes, offset);
            nodes.set(node.path, grown);
            return bytes.length;
        },
        truncate(){},
        close(){},
        remove: ()=>false,
        mkdir: ()=>false,
        rename: ()=>false,
        list: ()=>[],
        currentDirectory: ()=>'C:\\WORK',
        setCurrentDirectory(){},
    };
}

function setup(){
    const memory = fakeMemory();
    const files = fakeFiles();
    const fns = createProfileFunctions({
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        files,
    });
    return { memory, files, fns };
}

const INI = [
    '; a comment',
    '[Startup]',
    'EngineDir = "C:\\Temp\\_is12"  ',
    'FolderCount=2',
    "Quoted='x'",
    'Negative= -5',
    'Mixed=12abc',
    'Words=none',
    '',
    '[Other]',
    'Key=Value',
].join('\r\n') + '\r\n';

test('a value is found by section and key, folded, stripped of blanks and one pair of quotes', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\setup.ini', INI);
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\setup.ini');
    memory.put(DEFAULT, 'dflt  ');

    memory.put(SECTION, 'startup');
    memory.put(KEY, 'enginedir');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, DEFAULT, OUT, 64, FILE]), 13);
    assert.equal(memory.readCString(OUT, 64), 'C:\\Temp\\_is12');

    memory.put(KEY, 'Quoted');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, DEFAULT, OUT, 64, FILE]), 1);
    assert.equal(memory.readCString(OUT, 64), 'x');

    memory.put(KEY, 'Missing');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, DEFAULT, OUT, 64, FILE]), 4);
    assert.equal(memory.readCString(OUT, 64), 'dflt', 'the default, less its trailing blanks');

    memory.put(SECTION, 'Nowhere');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 64, FILE]), 0);
    assert.equal(memory.readCString(OUT, 64), '', 'a NULL default is the empty string');
});

test('a buffer too small is cut one short for a value and two short for a list', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\setup.ini', INI);
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\setup.ini');
    memory.put(SECTION, 'Startup');
    memory.put(KEY, 'EngineDir');

    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 4, FILE]), 3);
    assert.equal(memory.raw(OUT, 4), 'C:\\\0');

    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, 0, 0, OUT, 64, FILE]),
        'EngineDir\0FolderCount\0Quoted\0Negative\0Mixed\0Words\0'.length);
    assert.equal(memory.raw(OUT, 12), 'EngineDir\0Fo', 'keys, each NUL-terminated');
    assert.equal(fns.GetPrivateProfileStringA.handler([0, 0, 0, OUT, 64, FILE]),
        'Startup\0Other\0'.length);
    assert.equal(memory.raw(OUT, 15), 'Startup\0Other\0\0', 'sections, ended by a second NUL');

    assert.equal(fns.GetPrivateProfileStringA.handler([0, 0, 0, OUT, 6, FILE]), 4);
    assert.equal(memory.raw(OUT, 6), 'Star\0\0');

    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 0, FILE]), 0,
        'no room is no answer');
});

test('an integer is read the way the C runtime reads one, and a missing key is the default', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\setup.ini', INI);
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\setup.ini');
    memory.put(SECTION, 'Startup');

    memory.put(KEY, 'FolderCount');
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, 7, FILE]), 2);
    memory.put(KEY, 'Negative');
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, 7, FILE]), 0xfffffffb);
    memory.put(KEY, 'Mixed');
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, 7, FILE]), 12);
    memory.put(KEY, 'Words');
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, 7, FILE]), 0,
        'a key that is there but not a number is zero, not the default');
    memory.put(KEY, 'Missing');
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, -1, FILE]), 0xffffffff,
        'the default, as the unsigned value the signature promises');
});

test('a bare file name lives in the Windows directory and a missing file is all defaults', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\win.ini', '[Fonts]\r\nFace=Arial\r\n');
    memory.put(FILE, 'win.ini');
    memory.put(SECTION, 'Fonts');
    memory.put(KEY, 'Face');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 64, FILE]), 5);
    assert.equal(memory.readCString(OUT, 64), 'Arial');

    memory.put(FILE, 'nothing.ini');
    memory.put(DEFAULT, 'd');
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, DEFAULT, OUT, 64, FILE]), 1);
    assert.equal(fns.GetPrivateProfileIntA.handler([SECTION, KEY, 9, FILE]), 9);
    assert.equal(files.nodes.has('C:\\WINDOWS\\nothing.ini'), false, 'a read creates nothing');
});

test('a write replaces a key in place, adds what is missing, and removes with NULL', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\_isdelet.ini', INI);
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\_isdelet.ini');
    memory.put(SECTION, 'Startup');
    memory.put(KEY, 'FolderCount');
    memory.put(VALUE, '3');

    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, VALUE, FILE]), 1);
    const lines = files.text('C:\\WINDOWS\\TEMP\\_isdelet.ini').split('\r\n');
    assert.equal(lines[0], '; a comment', 'the rest of the file is as it was');
    assert.equal(lines[3], 'FolderCount=3');
    assert.equal(lines[4], "Quoted='x'");

    memory.put(KEY, 'File0');
    memory.put(VALUE, 'C:\\Temp\\a.tmp');
    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, VALUE, FILE]), 1);
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 64, FILE]), 13);
    assert.equal(memory.readCString(OUT, 64), 'C:\\Temp\\a.tmp');
    assert.match(files.text('C:\\WINDOWS\\TEMP\\_isdelet.ini'),
        /File0=C:\\Temp\\a\.tmp\r\n\[Other\]/, 'a new key goes at the end of its section');

    memory.put(SECTION, 'Fresh');
    memory.put(KEY, 'K');
    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, VALUE, FILE]), 1);
    assert.match(files.text('C:\\WINDOWS\\TEMP\\_isdelet.ini'), /\[Fresh\]\r\nK=C:\\Temp\\a\.tmp\r\n$/);

    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, 0, FILE]), 1);
    assert.doesNotMatch(files.text('C:\\WINDOWS\\TEMP\\_isdelet.ini'), /K=/, 'a NULL string removes the key');
    memory.put(SECTION, 'Other');
    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, 0, 0, FILE]), 1);
    assert.doesNotMatch(files.text('C:\\WINDOWS\\TEMP\\_isdelet.ini'), /Other|Key=Value/,
        'a NULL key removes the section');

    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\new.ini');
    memory.put(SECTION, 'S');
    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, VALUE, FILE]), 1);
    assert.equal(files.text('C:\\WINDOWS\\TEMP\\new.ini'), '[S]\r\nK=C:\\Temp\\a.tmp\r\n',
        'a write creates the file');
    assert.equal(fns.WritePrivateProfileStringA.handler([0, KEY, VALUE, FILE]), 0,
        'a NULL section is refused');
});

test('a section is read back as its entries, key=value each, and win.ini is a fixed name', ()=>{
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\setup.ini', INI);
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\setup.ini');
    memory.put(SECTION, 'Other');

    assert.equal(fns.GetPrivateProfileSectionA.handler([SECTION, OUT, 64, FILE]),
        'Key=Value\0'.length);
    assert.equal(memory.raw(OUT, 11), 'Key=Value\0\0');
    memory.put(SECTION, 'Nowhere');
    assert.equal(fns.GetPrivateProfileSectionA.handler([SECTION, OUT, 64, FILE]), 0);
    assert.equal(memory.raw(OUT, 1), '\0');
    assert.equal(fns.GetPrivateProfileSectionA.argBytes, 16);

    assert.equal(fns.GetPrivateProfileSectionNamesA.handler([OUT, 64, FILE]),
        'Startup Other '.length);
    assert.equal(memory.raw(OUT, 15), 'Startup Other  ');
    assert.equal(fns.GetPrivateProfileSectionNamesA.handler([OUT, 6, FILE]), 4,
        'cut two short, like every list');
    assert.equal(memory.raw(OUT, 6), 'Star  ');
    assert.equal(fns.GetPrivateProfileSectionNamesA.argBytes, 12);

    memory.put(SECTION, 'Desktop');
    memory.put(KEY, 'Wallpaper');
    memory.put(VALUE, 'none');
    assert.equal(fns.WriteProfileStringA.handler([SECTION, KEY, VALUE]), 1);
    assert.equal(files.text('C:\\WINDOWS\\win.ini'), '[Desktop]\r\nWallpaper=none\r\n');
    assert.equal(fns.GetProfileStringA.handler([SECTION, KEY, 0, OUT, 64]), 4);
    assert.equal(memory.readCString(OUT, 64), 'none');
    assert.equal(fns.GetProfileIntA.handler([SECTION, KEY, 7]), 0, 'a word is zero');
    assert.equal(fns.GetProfileStringA.argBytes, 20);
    assert.equal(fns.GetProfileIntA.argBytes, 12);
    assert.equal(fns.WriteProfileStringA.argBytes, 12);
});

test('a structure is kept as hex with a checksum, and read back only whole and intact', ()=>{
    // Wine's profile test: "abacus" and its terminator are 616261637573006F,
    // the last byte the sum of the others; a length or a checksum that does
    // not match is refused rather than read as far as it goes.
    const ERROR_BAD_LENGTH = 24;
    const ERROR_INVALID_DATA = 13;
    const memory = fakeMemory();
    const files = fakeFiles();
    /** @type {number[]} */
    const errors = [];
    const fns = createProfileFunctions({
        writeMemory: memory.writeMemory,
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>memory.bytes.slice(address, address + length),
        setLastError: code=>errors.push(code),
        files,
    });
    memory.put(SECTION, 's');
    memory.put(KEY, 'key');
    memory.put(FILE, 'C:\\WORK\\winetest.ini');
    memory.put(VALUE, 'abacus');

    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 7, FILE]), 0,
        'nothing there yet');
    assert.equal(errors.at(-1), ERROR_BAD_LENGTH);
    assert.equal(fns.WritePrivateProfileStructA.handler([SECTION, KEY, VALUE, 7, FILE]), 1);
    assert.equal(files.text('C:\\WORK\\winetest.ini'), '[s]\r\nkey=616261637573006F\r\n');

    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 6, FILE]), 0);
    assert.equal(errors.at(-1), ERROR_BAD_LENGTH);
    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 8, FILE]), 0);
    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 7, FILE]), 1);
    assert.equal(memory.readCString(OUT, 16), 'abacus');

    memory.put(DEFAULT, '636163747573006F');
    fns.WritePrivateProfileStringA.handler([SECTION, KEY, DEFAULT, FILE]);
    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 7, FILE]), 0,
        'the checksum is not cactus\'s');
    assert.equal(errors.at(-1), ERROR_INVALID_DATA);
    memory.put(DEFAULT, '6361637475730083');
    fns.WritePrivateProfileStringA.handler([SECTION, KEY, DEFAULT, FILE]);
    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 7, FILE]), 1,
        'lower or upper case alike');
    assert.equal(memory.readCString(OUT, 16), 'cactus');
    memory.put(DEFAULT, '636163747573008Q');
    fns.WritePrivateProfileStringA.handler([SECTION, KEY, DEFAULT, FILE]);
    assert.equal(fns.GetPrivateProfileStructA.handler([SECTION, KEY, OUT, 7, FILE]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_DATA);

    assert.equal(fns.WritePrivateProfileStructA.handler([SECTION, KEY, 0, 7, FILE]), 1,
        'no structure removes the key');
    assert.equal(files.text('C:\\WORK\\winetest.ini'), '[s]\r\n');
    assert.equal(fns.GetPrivateProfileStructA.argBytes, 20);
    assert.equal(fns.WritePrivateProfileStructA.argBytes, 20);
});

test('a section read whole keeps its lines that have no =, as Windows returns them', ()=>{
    // Wine's kernel32 test_profile_sections: section1 comes back as
    // "name1=val1", "name2=", "name3", "name4=val4" -- the bare "name3"
    // included -- and a section of one "=val5" as that line.
    const { memory, files, fns } = setup();
    files.put('C:\\WINDOWS\\TEMP\\list.ini', ['[section1]', 'name1=val1', 'name2=', 'name3',
        'name4=val4', '; a comment', '', '[section3]', '=val5', ''].join('\r\n'));
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\list.ini');
    memory.put(SECTION, 'section1');
    assert.equal(fns.GetPrivateProfileSectionA.handler([SECTION, OUT, 100, FILE]), 35);
    assert.equal(memory.raw(OUT, 36), 'name1=val1\0name2=\0name3\0name4=val4\0\0');
    memory.put(SECTION, 'section3');
    assert.equal(fns.GetPrivateProfileSectionA.handler([SECTION, OUT, 100, FILE]), 6);
    assert.equal(memory.raw(OUT, 7), '=val5\0\0');
});

test('a file\'s upper-half bytes are the ANSI page, as a program\'s own strings are', ()=>{
    // 0x80 is the euro sign, 0x99 the trade mark and 0x97 an em dash, both in
    // the file and in the names a program asks for, so a key spelled with them
    // is found, and a value written with them is in the file as those bytes.
    const { memory, files, fns } = setup();
    files.nodes.set('C:\\WINDOWS\\TEMP\\page.ini', Uint8Array.of(
        0x5b, 0x53, 0x99, 0x5d, 0x0d, 0x0a, 0x4b, 0x80, 0x3d, 0x97, 0xe9, 0x0d, 0x0a));
    memory.put(FILE, 'C:\\WINDOWS\\TEMP\\page.ini');
    memory.bytes.set([0x53, 0x99, 0], SECTION);
    memory.bytes.set([0x4b, 0x80, 0], KEY);
    assert.equal(fns.GetPrivateProfileStringA.handler([SECTION, KEY, 0, OUT, 64, FILE]), 2);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 3)], [0x97, 0xe9, 0]);

    memory.bytes.set([0x99, 0x80, 0], VALUE);
    assert.equal(fns.WritePrivateProfileStringA.handler([SECTION, KEY, VALUE, FILE]), 1);
    assert.deepEqual([.../** @type {Uint8Array} */ (files.nodes.get('C:\\WINDOWS\\TEMP\\page.ini'))],
        [0x5b, 0x53, 0x99, 0x5d, 0x0d, 0x0a, 0x4b, 0x80, 0x3d, 0x99, 0x80, 0x0d, 0x0a]);
});
