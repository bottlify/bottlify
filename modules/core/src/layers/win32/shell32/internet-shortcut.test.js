/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import {
    IID_IPERSIST_FILE, IID_IURL_A, IID_IURL_W, URL_E_INVALID_SYNTAX, createInternetShortcut,
    urlOfShortcut,
} from './internet-shortcut.js';

const S_OK = 0;
const S_FALSE = 1;
const E_PATH_NOT_FOUND = 0x80070003 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;

/** A guest memory, a task heap and a volume of two directories. */
function setup(){
    const memory = new Uint8Array(0x10000);
    let next = 0x8000;
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    const directories = new Set(['C:\\Start Menu']);
    /** @param {number} at */
    const readCString = at=>decodeAnsi(memory.subarray(at, memory.indexOf(0, at)));
    /** @param {number} at */
    const readWideString = at=>{
        let text = '';
        for (let unit = memory[at] | (memory[at + 1] << 8); unit !== 0;
            at += 2, unit = memory[at] | (memory[at + 1] << 8))
        {
            text += String.fromCharCode(unit);
        }
        return text;
    };
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readCString, readWideString,
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 8;
            return at;
        },
        files: {
            stat: (/** @type {string} */ path)=>(directories.has(path)
                ? { exists: true, isDirectory: true }
                : files.has(path) ? { exists: true, isDirectory: false,
                    size: /** @type {Uint8Array} */ (files.get(path)).length } : null),
            open: (/** @type {string} */ path)=>({ path }),
            read: (/** @type {any} */ node)=>/** @type {Uint8Array} */ (files.get(node.path)),
            write: (/** @type {any} */ node, /** @type {number} */ _offset,
                /** @type {Uint8Array} */ bytes)=>files.set(node.path, bytes.slice()),
            close: ()=>{},
        },
    };
    const object = createInternetShortcut(/** @type {any} */ (host))();
    /**
     * @param {string} iid @param {string} name @param {number[]} args
     * @returns {any}
     */
    const call = (iid, name, args)=>{
        const face = object.interfaces.find(each=>each.id === iid);
        const method = face?.methods.find(each=>each.name === name);
        return /** @type {any} */ (method).invoke(object, args);
    };
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>{
        memory.set(encodeAnsi(`${text}\0`), at);
        return at;
    };
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((character, index)=>{
            memory[at + index * 2] = character.charCodeAt(0) & 0xff;
            memory[at + index * 2 + 1] = character.charCodeAt(0) >>> 8;
        });
        return at;
    };
    const pointer = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    return { files, call, ansi, wide, pointer, readCString, readWideString };
}

test('a setup\'s link to its site is saved as the .url the shell reads, and loads back', ()=>{
    const m = setup();
    assert.equal(m.call(IID_IURL_A, 'GetURL', [0x100]), S_FALSE, 'nothing set yet');
    assert.equal(m.pointer(0x100), 0);
    assert.equal(m.call(IID_IURL_A, 'SetURL', [m.ansi(0x200, 'http://www.example.com/'), 0]),
        S_OK);
    assert.equal(m.call(IID_IPERSIST_FILE, 'IsDirty', []), S_OK);
    assert.equal(m.call(IID_IPERSIST_FILE, 'Save',
        [m.wide(0x400, 'C:\\Start Menu\\Site.url'), 1]), S_OK);
    assert.equal(decodeAnsi(/** @type {Uint8Array} */ (m.files.get('C:\\Start Menu\\Site.url'))),
        '[InternetShortcut]\r\nURL=http://www.example.com/\r\n');
    assert.equal(m.call(IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE);

    const other = setup();
    other.files.set('C:\\Start Menu\\Site.url',
        encodeAnsi('[DEFAULT]\r\nBASEURL=http://a/\r\n[internetshortcut]\r\nurl = http://b/\r\n'));
    assert.equal(other.call(IID_IPERSIST_FILE, 'Load',
        [other.wide(0x400, 'C:\\Start Menu\\Site.url'), 0]), S_OK);
    assert.equal(other.call(IID_IURL_W, 'GetURL', [0x100]), S_OK);
    assert.equal(other.readWideString(other.pointer(0x100)), 'http://b/',
        'the section and key without regard to case, the other section aside');
    assert.equal(other.call(IID_IPERSIST_FILE, 'Load',
        [other.wide(0x400, 'C:\\Start Menu\\None.url'), 0]), STG_E_FILENOTFOUND);
});

test('an address with no protocol is refused unless one may be supplied', ()=>{
    const m = setup();
    assert.equal(m.call(IID_IURL_A, 'SetURL', [m.ansi(0x200, 'www.example.com'), 0]),
        URL_E_INVALID_SYNTAX);
    assert.equal(m.call(IID_IURL_A, 'SetURL', [m.ansi(0x200, 'www.example.com'), 1]), S_OK);
    assert.equal(m.call(IID_IURL_A, 'GetURL', [0x100]), S_OK);
    assert.equal(m.readCString(m.pointer(0x100)), 'http://www.example.com');
    assert.equal(m.call(IID_IPERSIST_FILE, 'Save',
        [m.wide(0x400, 'C:\\Missing\\Site.url'), 1]), E_PATH_NOT_FOUND,
    'a folder that is not there');
});

test('the .url reader takes the shortcut section\'s address and nothing else', ()=>{
    assert.equal(urlOfShortcut('[Other]\nURL=x\n'), null);
    assert.equal(urlOfShortcut('[InternetShortcut]\nIconIndex=0\nURL=file:///C:/a.htm'),
        'file:///C:/a.htm');
});
