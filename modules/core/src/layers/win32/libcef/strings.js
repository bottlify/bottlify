/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The framework's strings, lists and maps.
 *
 * cef_string_t is whichever form the framework was built with -- UTF-16 by
 * default (`cef_string_utf16_t`: char16_t* str, size_t length, void
 * (*dtor)(char16_t*)), UTF-8 (the same shape over bytes) in a build made with
 * CEF_STRING_TYPE_UTF8, which a program shows by setting its strings with
 * cef_string_utf8_set before handing them over; a string this library fills
 * is its own copy with its own destructor, one the program fills is read and
 * left alone. A userfree string is such a
 * structure allocated here, which the program frees through the library. A
 * list, map or multimap is a handle the program never looks inside.
 */

/** cef_string_*_t: str, length, dtor. */
const STRING_SIZE = 12;

/**
 * @typedef {Object} CefStringsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(name: string, fn: { convention: 'cdecl', argBytes: number,
 *     handler: (args: number[]) => any }) => number} register
 */

/**
 * @param {CefStringsHost} host
 * @param {{ utf8?: boolean }} [form]  Whether cef_string_t is the UTF-8 form.
 */
export function createCefStrings(host, { utf8 = false } = {}){
    /** @param {number} address */
    const dword = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number[]} values */
    const words = (address, values)=>{
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, i)=>view.setUint32(i * 4, value >>> 0, true));
        host.writeMemory(address >>> 0, bytes);
    };

    /** The destructor every string this library fills carries: it frees the buffer. */
    let ownDtor = 0;
    const dtor = ()=>{
        ownDtor ||= host.register('cef_string.dtor', { convention: 'cdecl', argBytes: 4,
            handler: ([str])=>{
                if ((str >>> 0) !== 0)
                {
                    host.free(str >>> 0);
                }
                return 0;
            } });
        return ownDtor;
    };

    /** @param {number} at  A cef_string_*_t; what it held, freed when it is ours. */
    const clear = at=>{
        if ((at >>> 0) === 0)
        {
            return;
        }
        const str = dword(at);
        if (str !== 0 && dword(at + 8) === ownDtor && ownDtor !== 0)
        {
            host.free(str);
        }
        words(at, [0, 0, 0]);
    };

    /** @param {number} at @param {Uint8Array} bytes @param {number} length  In units. */
    const fill = (at, bytes, length)=>{
        clear(at);
        const str = host.allocate(bytes.length + 2) >>> 0;
        host.writeMemory(str, bytes);
        host.writeMemory(str + bytes.length, new Uint8Array(2));
        words(at, [str, length, dtor()]);
    };

    /** @param {string} text */
    const utf16 = text=>{
        const bytes = new Uint8Array(text.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(i * 2, text.charCodeAt(i), true);
        }
        return bytes;
    };

    /**
     * A cef_string_utf16_t's text or, wide false, a cef_string_utf8_t's.
     *
     * @param {number} at @param {boolean} wide
     */
    const readAs = (at, wide)=>{
        if ((at >>> 0) === 0)
        {
            return '';
        }
        const str = dword(at);
        const length = dword(at + 4);
        if (str === 0 || length === 0)
        {
            return '';
        }
        if (!wide)
        {
            return new TextDecoder().decode(host.readMemory(str, length).slice());
        }
        const bytes = host.readMemory(str, length * 2).slice();
        return String.fromCharCode(...new Uint16Array(bytes.buffer, 0, length));
    };

    /** @param {number} at @param {string} text @param {boolean} wide */
    const writeAs = (at, text, wide)=>{
        if (wide)
        {
            fill(at, utf16(text), text.length);
            return;
        }
        const bytes = new TextEncoder().encode(text);
        fill(at, bytes, bytes.length);
    };

    /** A cef_string_t in the framework's own form. @param {number} at */
    const read = at=>readAs(at, !utf8);
    /** @param {number} at @param {string} text */
    const write = (at, text)=>writeAs(at, text, !utf8);

    /** @param {string} text @returns {number} a userfree string the program frees */
    const userfree = text=>{
        const at = host.allocate(STRING_SIZE) >>> 0;
        words(at, [0, 0, 0]);
        write(at, text);
        return at;
    };

    /** @param {number} address @param {number} count  Bytes, or up to the NUL when -1. */
    const bytesAt = (address, count)=>{
        if ((address >>> 0) === 0)
        {
            return new Uint8Array(0);
        }
        if (count >= 0)
        {
            return host.readMemory(address >>> 0, count).slice();
        }
        const out = [];
        for (let at = address >>> 0; ; at++)
        {
            const byte = host.readMemory(at, 1)[0];
            if (byte === 0)
            {
                break;
            }
            out.push(byte);
        }
        return Uint8Array.from(out);
    };

    /** Lists, maps and multimaps by handle: a handle is a word of guest memory. */
    /** @type {Map<number, string[] | [string, string][]>} */
    const collections = new Map();
    /** @param {string[] | [string, string][]} items */
    const collection = items=>{
        const at = host.allocate(4) >>> 0;
        collections.set(at, items);
        return at;
    };
    /** @param {number} handle */
    const list = handle=>/** @type {string[]} */ (collections.get(handle >>> 0) ?? []);
    /** @param {number} handle */
    const map = handle=>/** @type {[string, string][]} */ (collections.get(handle >>> 0) ?? []);
    /** @param {number} handle */
    const drop = handle=>{
        if (collections.delete(handle >>> 0))
        {
            host.free(handle >>> 0);
        }
    };

    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number | void} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes, handler: (/** @type {number[]} */ args)=>handler(args) ?? 0 });

    const exports = {
        // The UTF-8 and UTF-16 forms a program's own code uses.
        cef_string_utf8_set: cdecl(16, ([src, length, output, copy])=>{
            if ((output >>> 0) === 0)
            {
                return 0;
            }
            if (copy === 0)
            {
                clear(output);
                words(output, [src, length, 0]);
                return 1;
            }
            fill(output, bytesAt(src, length >>> 0), length >>> 0);
            return 1;
        }),
        cef_string_utf8_clear: cdecl(4, ([at])=>void clear(at)),
        cef_string_utf16_clear: cdecl(4, ([at])=>void clear(at)),
        cef_string_utf8_cmp: cdecl(8, ([a, b])=>{
            const left = bytesAt(dword(a), dword(a + 4));
            const right = bytesAt(dword(b), dword(b + 4));
            for (let i = 0; i < Math.min(left.length, right.length); i++)
            {
                if (left[i] !== right[i])
                {
                    return left[i] < right[i] ? -1 : 1;
                }
            }
            return Math.sign(left.length - right.length);
        }),
        cef_string_wide_to_utf8: cdecl(12, ([src, length, output])=>{
            const raw = host.readMemory(src >>> 0, (length >>> 0) * 2).slice();
            const text = String.fromCharCode(...new Uint16Array(raw.buffer, 0, length >>> 0));
            const bytes = new TextEncoder().encode(text);
            fill(output, bytes, bytes.length);
            return 1;
        }),
        cef_string_utf8_to_utf16: cdecl(12, ([src, length, output])=>{
            writeAs(output, new TextDecoder().decode(bytesAt(src, length >>> 0)), true);
            return 1;
        }),
        cef_string_userfree_utf8_free: cdecl(4, ([at])=>{
            if ((at >>> 0) !== 0)
            {
                clear(at);
                host.free(at >>> 0);
            }
        }),
        cef_string_userfree_utf16_free: cdecl(4, ([at])=>{
            if ((at >>> 0) !== 0)
            {
                clear(at);
                host.free(at >>> 0);
            }
        }),

        cef_string_list_alloc: cdecl(0, ()=>collection([])),
        cef_string_list_free: cdecl(4, ([handle])=>void drop(handle)),
        cef_string_list_size: cdecl(4, ([handle])=>list(handle).length),
        cef_string_list_value: cdecl(12, ([handle, index, value])=>{
            const item = list(handle)[index >>> 0];
            if (item === undefined)
            {
                return 0;
            }
            write(value, item);
            return 1;
        }),
        cef_string_list_append: cdecl(8, ([handle, value])=>void list(handle).push(read(value))),

        cef_string_map_alloc: cdecl(0, ()=>collection([])),
        cef_string_map_free: cdecl(4, ([handle])=>void drop(handle)),
        cef_string_map_size: cdecl(4, ([handle])=>map(handle).length),
        cef_string_map_key: cdecl(12, ([handle, index, out])=>{
            const pair = map(handle)[index >>> 0];
            if (!pair)
            {
                return 0;
            }
            write(out, pair[0]);
            return 1;
        }),
        cef_string_map_value: cdecl(12, ([handle, index, out])=>{
            const pair = map(handle)[index >>> 0];
            if (!pair)
            {
                return 0;
            }
            write(out, pair[1]);
            return 1;
        }),
        cef_string_map_append: cdecl(12, ([handle, key, value])=>{
            map(handle).push([read(key), read(value)]);
            return 1;
        }),
    };
    // A multimap is the same list of pairs, keys allowed twice.
    const multimap = Object.fromEntries(['alloc', 'free', 'size', 'key', 'value', 'append']
        .map(op=>[`cef_string_multimap_${op}`,
            /** @type {Record<string, any>} */ (exports)[`cef_string_map_${op}`]]));

    return {
        exports: { ...exports, ...multimap },
        read,
        write,
        userfree,
        /** @param {string[]} items */
        fillList: (/** @type {number} */ handle, /** @type {string[]} */ items)=>{
            list(handle).push(...items);
        },
        /** @param {number} handle @param {[string, string][]} pairs */
        fillMap: (handle, pairs)=>{
            map(handle).push(...pairs);
        },
        /** @param {number} address @param {number} count */
        bytesAt,
    };
}
