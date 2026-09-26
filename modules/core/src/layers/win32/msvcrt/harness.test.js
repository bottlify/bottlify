/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest memory the msvcrt tests run against.
 *
 * `readMemory` hands back a view rather than a copy, deliberately: that is what
 * the real memory layer does, and a function that reads a block and then writes
 * over it -- a swap, an overlapping move -- only fails when the read is a view.
 * A test double that copied would pass either way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** How much the fake's scan reads at a time, as the real memory layer does. */
const SCAN_CHUNK = 256;

/**
 * @param {number} [base]
 * @param {number} [size]  Larger than the default for the tests that lay a
 *        megabyte down and ask what a scan of its front cost.
 */
export function fakeMemory(base = 0x10000, size = 1 << 20){
    const bytes = new Uint8Array(size);
    let next = base;

    const memory = {
        bytes,

        /**
         * Bytes the handlers asked memory for, reads only. The real layer
         * counts what its scan hands the emulator; counting what the fake is
         * asked is the same measurement from this side of the seam.
         */
        asked: 0,

        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            memory.asked += length;
            return bytes.subarray(address, address + length);
        },

        /** @param {number} address @param {Uint8Array} source */
        writeMemory: (address, source)=>bytes.set(source, address),

        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),

        /** @param {number} address @param {number} max */
        readCString: (address, max)=>{
            let text = '';
            for (let at = 0; at < max && bytes[address + at] !== 0; at++)
            {
                memory.asked++;
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },

        /**
         * @param {number} address @param {number} limit
         * @param {Uint8Array} [wanted]
         */
        scanCString: (address, limit, wanted = new Uint8Array(256))=>{
            for (let at = 0; at < limit; at += SCAN_CHUNK)
            {
                const chunk = memory.readMemory(address + at,
                    Math.min(SCAN_CHUNK, limit - at, size - address - at));
                for (let i = 0; i < chunk.length; i++)
                {
                    const byte = chunk[i];
                    if (byte === 0 || wanted[byte] !== 0)
                    {
                        return { index: at + i, byte };
                    }
                }
            }
            throw new Error(`No NUL within ${limit} bytes of 0x${address.toString(16)}`);
        },

        /** @param {number} count */
        allocate: count=>{
            const at = next;
            next += (count + 7) & ~7;
            return at;
        },

        /** Places a C string and answers where it went. @param {string} text */
        put(text){
            const at = memory.allocate(text.length + 1);
            memory.writeMemory(at, new Uint8Array(
                [...text].map(character=>character.charCodeAt(0)).concat(0)));
            return at;
        },

        /** @param {number} address */
        text: address=>memory.readCString(address, 1 << 16),

        /** @param {number} address */
        u32: address=>new DataView(bytes.buffer).getUint32(address, true),

        /** @param {number} address */
        i32: address=>new DataView(bytes.buffer).getInt32(address, true),

        /** @param {number} address @param {number} value */
        setU32(address, value){
            new DataView(bytes.buffer).setUint32(address, value >>> 0, true);
        },

        /** @param {number} address @param {number} count */
        wide(address, count = 1 << 12){
            let text = '';
            const view = new DataView(bytes.buffer);
            for (let at = 0; at < count; at++)
            {
                const unit = view.getUint16(address + at * 2, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },

        /** @param {string} text */
        putWide(text){
            const at = memory.allocate((text.length + 1) * 2);
            const view = new DataView(bytes.buffer);
            for (let unit = 0; unit < text.length; unit++)
            {
                view.setUint16(at + unit * 2, text.charCodeAt(unit), true);
            }
            view.setUint16(at + text.length * 2, 0, true);
            return at;
        },
    };
    return memory;
}

/**
 * A volume of byte arrays: a node is a path, reads and writes go straight
 * to the array, and a read may be handed back late to stand for a block
 * that is still on its way. A name in `directories` is a directory, listed
 * with the files whose names it holds.
 *
 * @param {Record<string, Uint8Array>} files
 * @param {{ late?: boolean, directories?: string[], modified?: number }} [options]
 */
export function fakeVolume(files, { late = false, directories = [], modified = 0 } = {}){
    /** @type {string[]} */
    const closed = [];
    const folders = new Set(directories);
    const volume = {
        files,
        closed,
        folders,
        /** How many reads reached the volume. */
        reads: 0,
        /**
         * @param {string} path
         * @param {{ create?: boolean, truncate?: boolean, failIfExists?: boolean }} mode
         */
        open(path, mode){
            if (folders.has(path) || (files[path] && mode.failIfExists)
                || (!files[path] && !mode.create))
            {
                return null;
            }
            if (!files[path] || mode.truncate)
            {
                files[path] = new Uint8Array(0);
            }
            return path;
        },
        /** @param {string} path */
        stat: path=>(folders.has(path)
            ? { exists: true, isDirectory: true, size: 0, modified }
            : (files[path]
                ? { exists: true, isDirectory: false, size: files[path].length, modified }
                : null)),
        /** @param {string} node @param {number} at @param {number} length */
        read(node, at, length){
            volume.reads++;
            const bytes = files[node].slice(at, at + length);
            return late ? Promise.resolve(bytes) : bytes;
        },
        /** @param {string} node @param {number} at @param {Uint8Array} bytes */
        write(node, at, bytes){
            const grown = new Uint8Array(Math.max(files[node].length, at + bytes.length));
            grown.set(files[node]);
            grown.set(bytes, at);
            files[node] = grown;
            return bytes.length;
        },
        /** @param {string} node */
        close: node=>closed.push(node),
        /** @param {string} path */
        remove(path){
            if (!files[path])
            {
                return false;
            }
            delete files[path];
            return true;
        },
        currentDirectory: ()=>'C:\\game',
        /**
         * What a directory holds whose names match a pattern of `*` and `?`,
         * `*.*` matching every name as it does on Windows.
         *
         * @param {string} directory @param {string} pattern
         */
        list(directory, pattern){
            const inside = `${directory.replace(/\\$/, '')}\\`;
            const wanted = new RegExp(`^${(pattern === '*.*' ? '*' : pattern)
                .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
            'i');
            return [...folders, ...Object.keys(files)]
                .filter(path=>path.startsWith(inside) && !path.slice(inside.length).includes('\\'))
                .map(path=>path.slice(inside.length))
                .filter(name=>name !== '' && wanted.test(name))
                .map(name=>({ name, ...volume.stat(inside + name) }));
        },
    };
    return volume;
}

/**
 * The double a cdecl caller pushed, as the two slots a handler receives.
 *
 * @param {number} value
 * @returns {number[]}
 */
export function doubleSlots(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getInt32(0, true), view.getInt32(4, true)];
}

/** An FPU seam that records what was left in ST(0). */
export function fakeFpu(){
    /** @type {number[]} */
    const stack = [];
    return {
        stack,
        result: NaN,
        /** @param {number} value */
        setResult(value){
            this.result = value;
            stack.unshift(value);
        },
        /** @param {number} index */
        get: index=>stack[index],
        pop: ()=>{
            stack.shift();
        },
        /** @param {number[]} values ST(0) first. */
        load(values){
            stack.length = 0;
            stack.push(...values);
        },
    };
}

test('the double reads back as a view, so a swap must copy to be correct', ()=>{
    const memory = fakeMemory();
    const at = memory.put('ab');
    const view = memory.readMemory(at, 2);
    memory.writeMemory(at, new Uint8Array([0x7a]));
    assert.equal(view[0], 0x7a, 'a view follows the write');
    assert.equal(memory.readMemory(at, 2).slice()[0], 0x7a);
});

test('strings placed by the harness read back through readCString', ()=>{
    const memory = fakeMemory();
    assert.equal(memory.text(memory.put('hello')), 'hello');
    assert.equal(memory.wide(memory.putWide('wide')), 'wide');
});
