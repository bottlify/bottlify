/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s codecs as a program lists them (ImageCodecInfo), the raw format
 * each image reports, and the two encoders this build has: BMP and PNG.
 *
 * Decoding is Windows' imaging component's (`windowscodecs/frames.js`): a
 * decoder is listed for each container it reads. An encoder is listed only
 * where an image can be written: BMP keeps the image's own depth where BMP
 * has it, PNG writes 8 bits a channel (a palette for an indexed image),
 * its data in stored deflate blocks - a valid PNG every reader opens, larger
 * than Windows' compressed one (decision A262).
 */

/** ImageFormat* GUIDs (gdiplusimaging.h), by name. */
export const IMAGE_FORMAT = Object.freeze({
    Undefined: '{B96B3CA9-0728-11D3-9D7B-0000F81EF32E}',
    MemoryBMP: '{B96B3CAA-0728-11D3-9D7B-0000F81EF32E}',
    Bmp: '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}',
    Emf: '{B96B3CAC-0728-11D3-9D7B-0000F81EF32E}',
    Wmf: '{B96B3CAD-0728-11D3-9D7B-0000F81EF32E}',
    Jpeg: '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}',
    Png: '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}',
    Gif: '{B96B3CB0-0728-11D3-9D7B-0000F81EF32E}',
    Tiff: '{B96B3CB1-0728-11D3-9D7B-0000F81EF32E}',
    Exif: '{B96B3CB2-0728-11D3-9D7B-0000F81EF32E}',
    Ico: '{B96B3CB5-0728-11D3-9D7B-0000F81EF32E}',
});

/** ImageCodecFlags. */
const Encoder = 1;
const Decoder = 2;
const SupportBitmap = 4;
const Builtin = 0x10000;

/**
 * @typedef {Object} Codec
 * @property {string} clsid
 * @property {string} format  its ImageFormat GUID
 * @property {string} name  the container's name as WIC names it
 * @property {string} codecName @property {string} description @property {string} extensions
 * @property {string} mime
 * @property {number} flags
 * @property {number[][]} patterns  the signatures, masks all ones
 */

/** @param {string} text */
const ascii = text=>Array.from(text, c=>c.charCodeAt(0));

/** @param {number} n  the codec's place in GDI+'s numbering */
const clsid = n=>`{557CF4${n.toString(16).toUpperCase().padStart(2, '0')}`
    + '-1A04-11D3-9A73-0000F81EF32E}';

/** @type {Codec[]} */
const DECODERS = [
    { clsid: clsid(0), format: IMAGE_FORMAT.Bmp, name: 'Bmp', codecName: 'Built-in BMP Codec',
        description: 'BMP', extensions: '*.BMP;*.DIB;*.RLE', mime: 'image/bmp',
        flags: Decoder | SupportBitmap | Builtin, patterns: [ascii('BM')] },
    { clsid: clsid(1), format: IMAGE_FORMAT.Jpeg, name: 'Jpeg', codecName: 'Built-in JPEG Codec',
        description: 'JPEG', extensions: '*.JPG;*.JPEG;*.JPE;*.JFIF', mime: 'image/jpeg',
        flags: Decoder | SupportBitmap | Builtin, patterns: [[0xff, 0xd8]] },
    { clsid: clsid(2), format: IMAGE_FORMAT.Gif, name: 'Gif', codecName: 'Built-in GIF Codec',
        description: 'GIF', extensions: '*.GIF', mime: 'image/gif',
        flags: Decoder | SupportBitmap | Builtin, patterns: [ascii('GIF87a'), ascii('GIF89a')] },
    { clsid: clsid(5), format: IMAGE_FORMAT.Tiff, name: 'Tiff', codecName: 'Built-in TIFF Codec',
        description: 'TIFF', extensions: '*.TIF;*.TIFF', mime: 'image/tiff',
        flags: Decoder | SupportBitmap | Builtin, patterns: [[0x49, 0x49], [0x4d, 0x4d]] },
    { clsid: clsid(6), format: IMAGE_FORMAT.Png, name: 'Png', codecName: 'Built-in PNG Codec',
        description: 'PNG', extensions: '*.PNG', mime: 'image/png',
        flags: Decoder | SupportBitmap | Builtin,
        patterns: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
    { clsid: clsid(7), format: IMAGE_FORMAT.Ico, name: 'Ico', codecName: 'Built-in ICO Codec',
        description: 'ICO', extensions: '*.ICO', mime: 'image/x-icon',
        flags: Decoder | SupportBitmap | Builtin, patterns: [[0, 0, 1, 0]] },
];

/** @type {Codec[]} */
const ENCODERS = [
    { ...DECODERS[0], flags: Encoder | SupportBitmap | Builtin },
    { ...DECODERS[4], flags: Encoder | SupportBitmap | Builtin },
];

export const decoders = ()=>DECODERS;
export const encoders = ()=>ENCODERS;

/** The ImageFormat a container WIC decodes reports. @param {string} name */
export const formatOfContainer = name=>
    /** @type {Record<string, string>} */ (IMAGE_FORMAT)[name] ?? IMAGE_FORMAT.Undefined;

/**
 * ImageCodecInfo: two GUIDs, five string pointers, four DWORDs, two byte
 * pointers - its size at a pointer's width.
 *
 * @param {number} pointer
 */
export const codecInfoSize = pointer=>32 + 7 * pointer + 16;

/**
 * The codecs as ImageCodecInfo records, then their strings and signatures,
 * laid out from `base` as GDI+ lays them in the caller's buffer.
 *
 * @param {Codec[]} codecs @param {number} base @param {number} pointer
 * @param {(text: string) => Uint8Array} guid  a GUID's bytes
 * @returns {Uint8Array}
 */
export function codecInfos(codecs, base, pointer, guid){
    const record = codecInfoSize(pointer);
    /** @type {number[]} */
    const tail = [];
    const head = new Uint8Array(record * codecs.length);
    const view = new DataView(head.buffer);
    const tailStart = base + head.length;
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = tailStart + tail.length;
        tail.push(...bytes);
        return at;
    };
    /** @param {string} text */
    const wide = text=>place([...Array.from(text, c=>[c.charCodeAt(0) & 0xff,
        c.charCodeAt(0) >> 8]).flat(), 0, 0]);
    /** @param {number} at @param {number} value */
    const putPointer = (at, value)=>(pointer === 8 ? view.setBigUint64(at, BigInt(value), true)
        : view.setUint32(at, value, true));
    codecs.forEach((codec, i)=>{
        const at = i * record;
        head.set(guid(codec.clsid), at);
        head.set(guid(codec.format), at + 16);
        let field = at + 32;
        for (const text of [codec.codecName, '', codec.description, codec.extensions,
            codec.mime])
        {
            putPointer(field, text === '' ? 0 : wide(text));
            field += pointer;
        }
        const size = Math.max(...codec.patterns.map(p=>p.length));
        view.setUint32(field, codec.flags, true);
        view.setUint32(field + 4, 1, true);
        view.setUint32(field + 8, codec.patterns.length, true);
        view.setUint32(field + 12, size, true);
        const padded = codec.patterns.flatMap(p=>[...p, ...new Array(size - p.length).fill(0)]);
        putPointer(field + 16, place(padded));
        putPointer(field + 16 + pointer, place(codec.patterns.flatMap(p=>[
            ...new Array(p.length).fill(0xff), ...new Array(size - p.length).fill(0)])));
    });
    const out = new Uint8Array(head.length + tail.length);
    out.set(head);
    out.set(tail, head.length);
    return out;
}

/**
 * An image to encode: its rows as stored, top-down, and how to read them.
 *
 * @typedef {Object} Encodable
 * @property {number} width @property {number} height
 * @property {number} bpp  1, 4, 8 (indexed), 24 or 32
 * @property {Uint8Array[]} rows  each packed, BGR(A) for 24 and 32
 * @property {number[]} palette  ARGB, for an indexed image
 * @property {boolean} alpha  whether a 32-bit row's fourth byte is alpha
 */

/**
 * A BMP file of the image: BITMAPFILEHEADER, BITMAPINFOHEADER, its palette,
 * rows bottom-up padded to four bytes.
 *
 * @param {Encodable} image
 */
export function encodeBmp({ width, height, bpp, rows, palette }){
    const stride = Math.ceil(width * bpp / 32) * 4;
    const colours = bpp <= 8 ? 1 << bpp : 0;
    const offset = 14 + 40 + colours * 4;
    const out = new Uint8Array(offset + stride * height);
    const view = new DataView(out.buffer);
    out.set(ascii('BM'));
    view.setUint32(2, out.length, true);
    view.setUint32(10, offset, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, bpp, true);
    view.setUint32(34, stride * height, true);
    // 96 DPI in pixels a metre.
    view.setInt32(38, 3780, true);
    view.setInt32(42, 3780, true);
    view.setUint32(46, colours, true);
    for (let i = 0; i < colours; i++)
    {
        view.setUint32(54 + i * 4, (palette[i] ?? 0) & 0xffffff, true);
    }
    rows.forEach((row, y)=>out.set(row.subarray(0, stride), offset + (height - 1 - y) * stride));
    return out;
}

/** CRC-32 (ISO 3309), as PNG's chunks carry it. */
const CRC_TABLE = (()=>{
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++)
    {
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/** @param {Uint8Array} bytes */
const crc32 = bytes=>{
    let c = 0xffffffff;
    for (const byte of bytes)
    {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ c >>> 8;
    }
    return (c ^ 0xffffffff) >>> 0;
};

/**
 * A zlib stream of `data` in stored deflate blocks.
 *
 * @param {Uint8Array} data
 */
const storedZlib = data=>{
    const blocks = Math.max(1, Math.ceil(data.length / 0xffff));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    out[0] = 0x78;
    out[1] = 0x01;
    let at = 2;
    for (let b = 0; b < blocks; b++)
    {
        const part = data.subarray(b * 0xffff, (b + 1) * 0xffff);
        out[at] = b === blocks - 1 ? 1 : 0;
        out[at + 1] = part.length & 0xff;
        out[at + 2] = part.length >> 8;
        out[at + 3] = ~part.length & 0xff;
        out[at + 4] = ~part.length >> 8 & 0xff;
        out.set(part, at + 5);
        at += 5 + part.length;
    }
    let a = 1;
    let s = 0;
    for (const byte of data)
    {
        a = (a + byte) % 65521;
        s = (s + a) % 65521;
    }
    new DataView(out.buffer).setUint32(at, (s << 16 | a) >>> 0);
    return out;
};

/**
 * A PNG file of the image: indexed images with their palette (PLTE, tRNS
 * where an entry is not opaque), the rest 8-bit RGB or RGBA.
 *
 * @param {Encodable} image
 */
export function encodePng({ width, height, bpp, rows, palette, alpha }){
    const indexed = bpp <= 8;
    const channels = indexed ? 1 : alpha ? 4 : 3;
    const rowLength = indexed ? Math.ceil(width * bpp / 8) : width * channels;
    const raw = new Uint8Array((rowLength + 1) * height);
    rows.forEach((row, y)=>{
        const at = y * (rowLength + 1) + 1;
        if (indexed)
        {
            raw.set(row.subarray(0, rowLength), at);
            return;
        }
        const step = bpp / 8;
        for (let x = 0; x < width; x++)
        {
            raw[at + x * channels] = row[x * step + 2];
            raw[at + x * channels + 1] = row[x * step + 1];
            raw[at + x * channels + 2] = row[x * step];
            if (alpha)
            {
                raw[at + x * channels + 3] = row[x * step + 3];
            }
        }
    });
    /** @type {Uint8Array[]} */
    const chunks = [];
    /** @param {string} type @param {Uint8Array} data */
    const chunk = (type, data)=>{
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        out.set(ascii(type), 4);
        out.set(data, 8);
        view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
        chunks.push(out);
    };
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = indexed ? bpp : 8;
    header[9] = indexed ? 3 : alpha ? 6 : 2;
    chunk('IHDR', header);
    if (indexed)
    {
        const colours = palette.slice(0, 1 << bpp);
        chunk('PLTE', Uint8Array.from(colours.flatMap(c=>[c >>> 16 & 0xff, c >>> 8 & 0xff,
            c & 0xff])));
        if (colours.some(c=>c >>> 24 !== 0xff))
        {
            chunk('tRNS', Uint8Array.from(colours.map(c=>c >>> 24)));
        }
    }
    chunk('IDAT', storedZlib(raw));
    chunk('IEND', new Uint8Array(0));
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const out = new Uint8Array(8 + chunks.reduce((n, c)=>n + c.length, 0));
    out.set(signature);
    let at = 8;
    for (const c of chunks)
    {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

/**
 * A GIF's frame delays (hundredths of a second) and loop count, from its
 * Graphic Control and NETSCAPE2.0 extensions: what GDI+ reports as the
 * PropertyTagFrameDelay and PropertyTagLoopCount of an animation.
 *
 * @param {Uint8Array} bytes
 * @returns {{ delays: number[], loop: number }}
 */
export function gifTiming(bytes){
    /** @type {number[]} */
    const delays = [];
    let loop = 1;
    let at = 13;
    if (bytes[10] & 0x80)
    {
        at += 3 << ((bytes[10] & 7) + 1);
    }
    let pending = 0;
    /** Past a run of sub-blocks. */
    const skip = ()=>{
        while (at < bytes.length && bytes[at] !== 0)
        {
            at += bytes[at] + 1;
        }
        at++;
    };
    while (at < bytes.length)
    {
        const kind = bytes[at];
        if (kind === 0x21)
        {
            const label = bytes[at + 1];
            at += 2;
            if (label === 0xf9 && bytes[at] >= 4)
            {
                pending = bytes[at + 2] | bytes[at + 3] << 8;
            }
            else if (label === 0xff && bytes[at] === 11
                && String.fromCharCode(...bytes.subarray(at + 1, at + 12)) === 'NETSCAPE2.0'
                && bytes[at + 12] >= 3)
            {
                loop = bytes[at + 14] | bytes[at + 15] << 8;
            }
            skip();
        }
        else if (kind === 0x2c)
        {
            delays.push(pending);
            pending = 0;
            const flags = bytes[at + 9];
            at += 10;
            if (flags & 0x80)
            {
                at += 3 << ((flags & 7) + 1);
            }
            at++;
            skip();
        }
        else
        {
            break;
        }
    }
    return { delays, loop };
}
