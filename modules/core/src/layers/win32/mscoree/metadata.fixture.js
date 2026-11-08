/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A small managed image, laid out by ECMA-335 partition II, for the tests of
 * what reads one: a PE32 with one section holding the CLI header, the
 * metadata root and its `#~`, `#Strings` and `#Blob` streams, the tables
 * Module, Assembly and File.
 */

/**
 * @typedef {Object} ImageShape
 * @property {string} [name]
 * @property {number[]} [version]
 * @property {string} [culture]
 * @property {Uint8Array} [publicKey]
 * @property {string[]} [files]     the File table's names
 * @property {string} [runtime]     the metadata root's version string
 * @property {number} [machine]
 * @property {number} [flags]       COMIMAGE_FLAGS
 * @property {boolean} [assembly]   false for a module without an Assembly row
 */

/** @param {ImageShape} [shape] */
export function managedImage(shape = {}){
    const { name = 'sample', version = [1, 2, 3, 4], culture = '', publicKey = new Uint8Array(0),
        files = [], runtime = 'v4.0.30319', machine = 0x14c, flags = 0x1,
        assembly = true } = shape;
    const encoder = new TextEncoder();
    // The heaps: strings with an empty one first, blobs likewise.
    /** @type {number[]} */
    const strings = [0];
    /** @param {string} text */
    const string = text=>{
        if (text === '')
        {
            return 0;
        }
        const at = strings.length;
        strings.push(...encoder.encode(text), 0);
        return at;
    };
    /** @type {number[]} */
    const blobs = [0];
    /** @param {Uint8Array} bytes */
    const blob = bytes=>{
        if (bytes.length === 0)
        {
            return 0;
        }
        const at = blobs.length;
        blobs.push(...bytes.length < 0x80 ? [bytes.length]
            : [0x80 | bytes.length >> 8, bytes.length & 0xff], ...bytes);
        return at;
    };
    const moduleName = string(`${name}.dll`);
    const assemblyName = string(name);
    const cultureName = string(culture);
    const key = blob(publicKey);
    const fileNames = files.map(string);

    /** @type {number[]} */
    const tables = [];
    const u16 = (/** @type {number} */ value)=>tables.push(value & 0xff, value >> 8 & 0xff);
    const u32 = (/** @type {number} */ value)=>{
        u16(value & 0xffff);
        u16(value >>> 16);
    };
    const present = [0x00, ...assembly ? [0x20] : [], ...files.length > 0 ? [0x26] : []];
    const valid = present.reduce((mask, table)=>mask | 1n << BigInt(table), 0n);
    u32(0);
    tables.push(2, 0, 0, 1);
    u32(Number(valid & 0xffffffffn));
    u32(Number(valid >> 32n));
    u32(0);
    u32(0);
    u32(1);
    if (assembly)
    {
        u32(1);
    }
    if (files.length > 0)
    {
        u32(files.length);
    }
    // Module: Generation, Name, Mvid, EncId, EncBaseId.
    [0, moduleName, 0, 0, 0].forEach(u16);
    if (assembly)
    {
        u32(0x8004);
        version.forEach(u16);
        u32(publicKey.length > 0 ? 1 : 0);
        [key, assemblyName, cultureName].forEach(u16);
    }
    for (const at of fileNames)
    {
        u32(0);
        u16(at);
        u16(0);
    }

    const pad = (/** @type {number[]} */ bytes)=>{
        while (bytes.length % 4 !== 0)
        {
            bytes.push(0);
        }
        return bytes;
    };
    const streams = [['#~', pad(tables)], ['#Strings', pad(strings)], ['#Blob', pad(blobs)]];
    const runtimeBytes = pad([...encoder.encode(runtime), 0]);
    /** @type {number[]} */
    const root = [];
    const rootU16 = (/** @type {number} */ value)=>root.push(value & 0xff, value >> 8 & 0xff);
    const rootU32 = (/** @type {number} */ value)=>{
        rootU16(value & 0xffff);
        rootU16(value >>> 16);
    };
    rootU32(0x424a5342);
    rootU16(1);
    rootU16(1);
    rootU32(0);
    rootU32(runtimeBytes.length);
    root.push(...runtimeBytes);
    rootU16(0);
    rootU16(streams.length);
    const headerSize = streams.reduce((sum, [label])=>sum + 8
        + pad([...encoder.encode(/** @type {string} */ (label)), 0]).length, 0);
    let offset = root.length + headerSize;
    for (const [label, bytes] of streams)
    {
        rootU32(offset);
        rootU32(bytes.length);
        root.push(...pad([...encoder.encode(/** @type {string} */ (label)), 0]));
        offset += bytes.length;
    }
    for (const [, bytes] of streams)
    {
        root.push(.../** @type {number[]} */ (bytes));
    }

    const file = new Uint8Array(0x200 + 0x50 + root.length);
    const view = new DataView(file.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x4550, true);
    view.setUint16(0x84, machine, true);
    view.setUint16(0x86, 1, true);
    view.setUint16(0x94, 224, true);
    view.setUint16(0x98, 0x10b, true);
    view.setUint32(0x98 + 96 + 14 * 8, 0x2000, true);
    view.setUint32(0x98 + 96 + 14 * 8 + 4, 0x48, true);
    const section = 0x98 + 224;
    view.setUint32(section + 8, file.length - 0x200, true);
    view.setUint32(section + 12, 0x2000, true);
    view.setUint32(section + 16, file.length - 0x200, true);
    view.setUint32(section + 20, 0x200, true);
    view.setUint32(0x200, 0x48, true);
    view.setUint32(0x200 + 8, 0x2050, true);
    view.setUint32(0x200 + 12, root.length, true);
    view.setUint32(0x200 + 16, flags, true);
    file.set(root, 0x250);
    return file;
}
