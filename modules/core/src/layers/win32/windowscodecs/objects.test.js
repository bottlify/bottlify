/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import { createWindowscodecs } from './functions.js';
import { GUID, INTERFACES } from './layout.js';
import { WINCODEC } from './frames.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;

/**
 * The imaging component over a flat memory, every object of ours called
 * straight through its interface records, as the bridge would.
 */
function setup(){
    const bytes = new Uint8Array(0x200000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, any>} */
    const records = new Map();
    /** @type {Map<any, number>} */
    const pointers = new Map();
    let nextPointer = 0x100000;
    let nextBlock = 0x1000;
    /** @type {string[]} */
    const said = [];
    const registry = createComRegistry();
    const host = {
        registry,
        vtables: {
            publish: (/** @type {any} */ object, /** @type {string} */ iid)=>{
                const record = object.interfaceFor(iid);
                if (!record)
                {
                    return 0;
                }
                if (!pointers.has(record))
                {
                    nextPointer += 0x10;
                    pointers.set(record, nextPointer);
                    records.set(nextPointer, record);
                }
                return /** @type {number} */ (pointers.get(record));
            },
        },
        objectAt: (/** @type {number} */ pointer)=>records.get(pointer)?.object ?? null,
        heap: {
            allocate: (/** @type {number} */ size)=>{
                const at = nextBlock;
                nextBlock += (size + 15) & ~15;
                return at;
            },
            free: ()=>{},
        },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        readWideString: (/** @type {number} */ at)=>{
            let text = '';
            for (let from = at; view.getUint16(from, true) !== 0; from += 2)
            {
                text += String.fromCharCode(view.getUint16(from, true));
            }
            return text;
        },
        callGuest: ()=>Promise.reject(new Error('no guest objects here')),
        currentThread: ()=>undefined,
        readFile: async()=>null,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            said.push(`${api}: ${detail}`),
    };
    const exports = createWindowscodecs(/** @type {any} */ (host));
    let scratch = 0x180000;
    /** A block of the test's own. @param {number} size */
    const block = size=>{
        const at = scratch;
        scratch += (size + 15) & ~15;
        return at;
    };
    /** @param {string} guid */
    const guidAt = guid=>{
        const at = block(16);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(guid)), at);
        return at;
    };
    /**
     * A method of an object of ours by name, through the interface at `pointer`.
     *
     * @param {number} pointer @param {string} name @param {number[]} args
     */
    const call = async(pointer, name, args)=>{
        const record = records.get(pointer);
        const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method, `${name} on the interface at ${pointer.toString(16)}`);
        return (await method.invoke(record.object, args)) | 0;
    };
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const factory = async()=>{
        const out = block(4);
        assert.equal(await exports.WICCreateImagingFactory_Proxy.handler([0x237, out]), S_OK);
        return u32(out);
    };
    /**
     * Makes something through the factory and answers its pointer.
     *
     * @param {number} f @param {string} name @param {number[]} args
     */
    const made = async(f, name, args = [])=>{
        const out = block(4);
        assert.equal(await call(f, name, [...args, out]), S_OK, name);
        return u32(out);
    };
    return { bytes, view, said, registry, exports, block, guidAt, call, u32, factory, made };
}

test('a bitmap from memory locks, copies and refuses a second writer', async()=>{
    const t = setup();
    const f = await t.factory();
    const pixels = t.block(12);
    t.bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], pixels);
    const format = t.guidAt(GUID.PixelFormat24bppBGR);
    const out = t.block(4);
    assert.equal(await t.call(f, 'CreateBitmapFromMemory', [2, 2, format, 5, 12, pixels, out]),
        E_INVALIDARG, 'a stride short of a row');
    assert.equal(await t.call(f, 'CreateBitmapFromMemory', [2, 2, format, 6, 11, pixels, out]),
        WINCODEC.INSUFFICIENTBUFFER);
    const bitmap = await t.made(f, 'CreateBitmapFromMemory', [2, 2, format, 6, 12, pixels]);
    const copy = t.block(16);
    assert.equal(await t.call(bitmap, 'CopyPixels', [0, 6, 12, copy]), S_OK);
    assert.deepEqual([...t.bytes.subarray(copy, copy + 12)],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const lockOut = t.block(4);
    assert.equal(await t.call(bitmap, 'Lock', [0, 2, lockOut]), S_OK);
    const lock = t.u32(lockOut);
    assert.equal(await t.call(bitmap, 'Lock', [0, 1, t.block(4)]), WINCODEC.ALREADYLOCKED);
    const stride = t.block(4);
    assert.equal(await t.call(lock, 'GetStride', [stride]), S_OK);
    assert.equal(t.u32(stride), 8, 'a row of the bitmap a whole number of dwords');
    const size = t.block(4);
    const data = t.block(4);
    assert.equal(await t.call(lock, 'GetDataPointer', [size, data]), S_OK);
    t.bytes[t.u32(data)] = 99;
    assert.equal(await t.call(bitmap, 'CopyPixels', [0, 6, 12, copy]), S_OK);
    assert.equal(t.bytes[copy], 99, 'the lock writes into the bitmap itself');
});

test('a converter makes grey by the weights Windows uses and checks its palette', async()=>{
    const t = setup();
    const f = await t.factory();
    const pixels = t.block(24);
    t.bytes.set([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 0, 255, 255, 255, 0,
        255, 255, 255], pixels);
    const bitmap = await t.made(f, 'CreateBitmapFromMemory',
        [8, 1, t.guidAt(GUID.PixelFormat24bppBGR), 24, 24, pixels]);
    const converter = await t.made(f, 'CreateFormatConverter');
    const copy = t.block(8);
    assert.equal(await t.call(converter, 'CopyPixels', [0, 8, 8, copy]), WINCODEC.WRONGSTATE);
    assert.equal(await t.call(converter, 'Initialize',
        [bitmap, t.guidAt(GUID.PixelFormat8bppIndexed), 0, 0, 0, 0, 0]), E_INVALIDARG,
    'an indexed target with no palette to use');
    assert.equal(await t.call(converter, 'Initialize',
        [bitmap, t.guidAt(GUID.PixelFormat8bppGray), 0, 0, 0, 0, 0]), S_OK);
    assert.equal(await t.call(converter, 'CopyPixels', [0, 8, 8, copy]), S_OK);
    assert.deepEqual([...t.bytes.subarray(copy, copy + 8)], [76, 220, 127, 0, 247, 145, 230, 255]);

    const can = t.block(4);
    assert.equal(await t.call(converter, 'CanConvert', [t.guidAt(GUID.PixelFormat32bppBGRA),
        t.guidAt(GUID.PixelFormat64bppRGBAHalf), can]), WINCODEC.UNSUPPORTEDPIXELFORMAT);
    assert.equal(t.u32(can), 0, 'half floats are not the default converter\'s');
});

test('WICConvertBitmapSource hands the source back when it is in the format already', async()=>{
    const t = setup();
    const f = await t.factory();
    const bitmap = await t.made(f, 'CreateBitmap', [4, 4, t.guidAt(GUID.PixelFormat32bppBGRA), 0]);
    const out = t.block(4);
    assert.equal(await t.exports.WICConvertBitmapSource.handler(
        [t.guidAt(GUID.PixelFormat32bppBGRA), bitmap, out]), S_OK);
    assert.equal(t.u32(out), bitmap);
    assert.equal(await t.exports.WICConvertBitmapSource.handler(
        [t.guidAt(GUID.VendorMicrosoft), bitmap, out]), WINCODEC.COMPONENTNOTFOUND);
});

test('a memory stream seeks, reads and refuses what does not fit as Windows does', async()=>{
    const t = setup();
    const f = await t.factory();
    const stream = await t.made(f, 'CreateStream');
    const memory = t.block(16);
    t.bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], memory);
    assert.equal(await t.call(stream, 'InitializeFromMemory', [memory, 16]), S_OK);
    assert.equal(await t.call(stream, 'InitializeFromMemory', [memory, 16]), WINCODEC.WRONGSTATE);
    const position = t.block(8);
    assert.equal(await t.call(stream, 'Seek', [0, 1, 0, position]), 0x80070216 | 0,
        'a position past 32 bits');
    assert.equal(await t.call(stream, 'Seek', [17, 0, 0, position]), E_INVALIDARG);
    assert.equal(await t.call(stream, 'Seek', [-1, -1, 2, position]), S_OK);
    assert.equal(t.u32(position), 15);
    const buffer = t.block(16);
    const done = t.block(4);
    assert.equal(await t.call(stream, 'Read', [buffer, 8, done]), S_OK, 'a short read is S_OK');
    assert.equal(t.u32(done), 1);
    assert.equal(t.bytes[buffer], 16);
    assert.equal(await t.call(stream, 'Seek', [0, 0, 0, 0]), S_OK);
    assert.equal(await t.call(stream, 'Write', [buffer, 17, done]), 0x80030070 | 0,
        'STG_E_MEDIUMFULL, nothing written');
    assert.equal(await t.call(stream, 'Read', [0, 1, done]), E_INVALIDARG);
});

/** A 2x2 PNG of 8-bit grey with a transparent level 0, rows 0,255 and 255,0. */
function greyPng(){
    const crcTable = Array.from({ length: 256 }, (_, n)=>{
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return c >>> 0;
    });
    /** @param {Uint8Array} data */
    const crc = data=>{
        let c = 0xffffffff;
        for (const b of data)
        {
            c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    };
    /** @param {string} type @param {number[]} data */
    const chunk = (type, data)=>{
        const body = Uint8Array.from([...type].map(c=>c.charCodeAt(0)).concat(data));
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length, false);
        out.set(body, 4);
        view.setUint32(8 + data.length, crc(body), false);
        return [...out];
    };
    // Stored (uncompressed) deflate: filter byte 0 before each row.
    const raw = [0, 0, 255, 0, 255, 0];
    let a = 1;
    let b = 0;
    for (const v of raw)
    {
        a = (a + v) % 65521;
        b = (b + a) % 65521;
    }
    const zlib = [0x78, 0x01, 1, raw.length, 0, ~raw.length & 0xff, 0xff, ...raw,
        b >> 8, b & 0xff, a >> 8, a & 0xff];
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...chunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 2, 8, 0, 0, 0, 0]), ...chunk('tRNS', [0, 0]),
        ...chunk('IDAT', zlib), ...chunk('IEND', [])]);
}

test('a PNG decodes from a stream: grey with a transparent level is indexed', async()=>{
    const t = setup();
    const f = await t.factory();
    const png = greyPng();
    const memory = t.block(png.length);
    t.bytes.set(png, memory);
    const stream = await t.made(f, 'CreateStream');
    assert.equal(await t.call(stream, 'InitializeFromMemory', [memory, png.length]), S_OK);
    const decoder = await t.made(f, 'CreateDecoderFromStream', [stream, 0, 0]);
    const container = t.block(16);
    assert.equal(await t.call(decoder, 'GetContainerFormat', [container]), S_OK);
    assert.deepEqual(t.bytes.subarray(container, container + 16),
        parseGuid(GUID.ContainerFormatPng));
    const count = t.block(4);
    assert.equal(await t.call(decoder, 'GetFrameCount', [count]), S_OK);
    assert.equal(t.u32(count), 1);
    assert.equal(await t.call(decoder, 'GetFrame', [1, t.block(4)]), E_INVALIDARG);
    const frame = await t.made(decoder, 'GetFrame', [0]);
    const format = t.block(16);
    assert.equal(await t.call(frame, 'GetPixelFormat', [format]), S_OK);
    assert.deepEqual(t.bytes.subarray(format, format + 16), parseGuid(GUID.PixelFormat8bppIndexed));
    const palette = await t.made(f, 'CreatePalette');
    assert.equal(await t.call(frame, 'CopyPalette', [palette]), S_OK);
    const colours = t.block(1024);
    const got = t.block(4);
    assert.equal(await t.call(palette, 'GetColors', [256, colours, got]), S_OK);
    assert.equal(t.u32(got), 256);
    assert.equal(t.u32(colours), 0, 'level 0 transparent');
    assert.equal(t.u32(colours + 4), 0xff010101);
    const pixels = t.block(4);
    assert.equal(await t.call(frame, 'CopyPixels', [0, 2, 4, pixels]), S_OK);
    assert.deepEqual([...t.bytes.subarray(pixels, pixels + 4)], [0, 255, 255, 0]);

    // Converted to premultiplied BGRA, the form WPF draws.
    const out = t.block(4);
    assert.equal(await t.exports.WICConvertBitmapSource.handler(
        [t.guidAt(GUID.PixelFormat32bppPBGRA), frame, out]), S_OK);
    const bgra = t.block(16);
    assert.equal(await t.call(t.u32(out), 'CopyPixels', [0, 8, 16, bgra]), S_OK);
    assert.deepEqual([...t.bytes.subarray(bgra, bgra + 8)], [0, 0, 0, 0, 255, 255, 255, 255]);
});

test('the proxies call the method of the object they are handed', async()=>{
    const t = setup();
    const f = await t.factory();
    const palette = t.block(4);
    assert.equal(await t.exports.IWICImagingFactory_CreatePalette_Proxy.handler([f, palette]),
        S_OK);
    assert.equal(await t.exports.IWICPalette_InitializePredefined_Proxy.handler(
        [t.u32(palette), 2, 0]), S_OK);
    const count = t.block(4);
    assert.equal(await t.exports.IWICPalette_GetColorCount_Proxy.handler([t.u32(palette), count]),
        S_OK);
    assert.equal(t.u32(count), 2);
    assert.ok(t.exports.IWICBitmapLock_GetDataPointer_STA_Proxy, 'the STA name of GetDataPointer');
});

test('the factory is a COM class, and what is not provided is refused and said', async()=>{
    const t = setup();
    const object = t.registry.create(GUID.CLSID_ImagingFactory);
    assert.ok(object);
    assert.ok(object.interfaceFor(INTERFACES.IWICImagingFactory.iid));
    assert.ok(t.registry.create(GUID.CLSID_PngDecoder));
    const f = await t.factory();
    const out = t.block(4);
    assert.equal(await t.call(f, 'CreateEncoder', [t.guidAt(GUID.ContainerFormatPng), 0, out]),
        WINCODEC.COMPONENTNOTFOUND);
    assert.ok(t.said.some(s=>s.startsWith('IWICImagingFactory::CreateEncoder')));
});
