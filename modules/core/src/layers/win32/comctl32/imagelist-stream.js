/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An image list written to a stream and read back: ImageList_Write and
 * ImageList_Read, which is how a program keeps a list in a file or hands it
 * to another process.
 *
 * What the 5.82 library writes is an ILHEAD -- 'IL', version 0x101, the
 * counts, the image size, the background colour, the flags and the four
 * overlays, packed to two bytes -- and then the list's image as a bitmap
 * file, and its mask the same way when it has one. The images lie four to a
 * row in rows enough for every place the list has room for, the image at the
 * depth the list was made with and the mask at one bit. Each bitmap file's
 * bfSize holds the size of its headers alone, not of the file (Wine's
 * check_bitmap_data, which runs against Windows), so a reader goes by the
 * headers and the depth, never by bfSize.
 *
 * The stream is the program's own object: its Read and Write are guest code,
 * called through its vtable with the bytes in guest memory.
 */

import { createImageLists } from './imagelist.js';

/** ILHEAD's fields and its packed size. */
const ILHEAD = Object.freeze({
    usMagic: 0, usVersion: 2, cCurImage: 4, cMaxImage: 6, cGrow: 8, cx: 10, cy: 12,
    bkcolor: 14, flags: 18, ovls: 20, SIZE: 28,
});
const IMAGELIST_MAGIC = 0x4c49;
const IMAGELIST_VERSION = 0x101;
/** How many images a row of a written bitmap holds. */
const TILE_COLUMNS = 4;

/** BITMAPFILEHEADER: 'BM', then the sizes, packed to two bytes. */
const BITMAPFILEHEADER_SIZE = 14;
const BITMAP_MAGIC = 0x4d42;
const BITMAPINFOHEADER_SIZE = 40;
/** The largest header a DIB may carry, BITMAPV5HEADER. */
const BITMAPV5HEADER_SIZE = 124;
const BI_RGB = 0;
const BI_BITFIELDS = 3;
const DIB_BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);
/**
 * The most bits a bitmap read out of a stream may have: a stream says how
 * large its bitmap is, and a wrong one must not make this allocate whatever
 * it said.
 */
const MAX_DIB_BITS = 1 << 26;

const ILC_MASK = 0x0001;

/** IStream's Read and Write, after IUnknown's three. */
const SLOT_STREAM_READ = 3;
const SLOT_STREAM_WRITE = 4;

/** @param {Uint8Array} bytes @param {number} [at] */
const u32 = (bytes, at = 0)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The header a list is written under.
 *
 * @param {import('./imagelist.js').ListFields} fields
 * @returns {Uint8Array}
 */
const headerBytes = fields=>{
    const bytes = new Uint8Array(ILHEAD.SIZE);
    const view = viewOf(bytes);
    view.setUint16(ILHEAD.usMagic, IMAGELIST_MAGIC, true);
    view.setUint16(ILHEAD.usVersion, IMAGELIST_VERSION, true);
    view.setUint16(ILHEAD.cCurImage, fields.count & 0xffff, true);
    view.setUint16(ILHEAD.cMaxImage, fields.max & 0xffff, true);
    view.setUint16(ILHEAD.cGrow, fields.grow & 0xffff, true);
    view.setUint16(ILHEAD.cx, fields.cx & 0xffff, true);
    view.setUint16(ILHEAD.cy, fields.cy & 0xffff, true);
    view.setUint32(ILHEAD.bkcolor, fields.background >>> 0, true);
    view.setUint16(ILHEAD.flags, fields.flags & 0xffff, true);
    fields.overlays.forEach((overlay, index)=>view.setInt16(ILHEAD.ovls + index * 2, overlay,
        true));
    return bytes;
};

/**
 * A DIB as a bitmap file: the file header, then the DIB's own.
 *
 * @param {import('./imagelist.js').Dib} dib
 * @returns {Uint8Array}
 */
const bitmapFile = dib=>{
    const headers = BITMAPFILEHEADER_SIZE + dib.info.length;
    const bytes = new Uint8Array(headers + dib.bits.length);
    const view = viewOf(bytes);
    view.setUint16(0, BITMAP_MAGIC, true);
    view.setUint32(2, headers, true);
    view.setUint32(10, headers, true);
    bytes.set(dib.info, BITMAPFILEHEADER_SIZE);
    bytes.set(dib.bits, headers);
    return bytes;
};

/**
 * @param {import('./imagelist.js').ImageListHost} host
 * @param {ReturnType<typeof import('./imagelist.js').createImageLists>} lists
 */
export function createImageListStreams(host, lists){
    /**
     * Whether everything a stream is used through is here: guest memory to
     * hold its bytes, and a way to call its methods.
     *
     * @param {string} api
     */
    const ready = api=>{
        if (host.call && host.allocate && host.release && host.readMemory)
        {
            return true;
        }
        host.divergence?.(api, 'no guest memory or guest calls to use a stream through');
        return false;
    };

    /**
     * A method of the stream, `this` first, as a COM method takes it.
     *
     * @param {number} stream @param {number} slot @param {number[]} args
     * @param {unknown} thread
     */
    const callMethod = async(stream, slot, args, thread)=>{
        const read = /** @type {NonNullable<typeof host.readMemory>} */ (host.readMemory);
        const entry = u32(read(u32(read(stream, 4)) + slot * 4, 4));
        const call = /** @type {NonNullable<typeof host.call>} */ (host.call);
        return (await call(entry, [stream, ...args], thread)) | 0;
    };

    /**
     * Guest memory for the length of `use`, which answers null without it.
     *
     * @template T
     * @param {number} bytes @param {(block: number) => Promise<T | null>} use
     * @returns {Promise<T | null>}
     */
    const lend = async(bytes, use)=>{
        const block = host.allocate?.(Math.max(bytes, 1)) ?? 0;
        if (block === 0)
        {
            return null;
        }
        try
        {
            return await use(block);
        }
        finally
        {
            host.release?.(block);
        }
    };

    /**
     * Bytes put into the stream through its own Write; whether it took them.
     *
     * @param {number} stream @param {Uint8Array} bytes @param {unknown} thread
     */
    const writeStream = async(stream, bytes, thread)=>(await lend(bytes.length, async block=>{
        host.writeMemory(block, bytes);
        return (await callMethod(stream, SLOT_STREAM_WRITE, [block, bytes.length, 0],
            thread)) >= 0;
    })) === true;

    /**
     * The next `length` bytes of the stream through its own Read, or null
     * when it fails or ends first: a list cut short is no list.
     *
     * @param {number} stream @param {number} length @param {unknown} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const readStream = (stream, length, thread)=>lend(length + 4, async block=>{
        const read = /** @type {NonNullable<typeof host.readMemory>} */ (host.readMemory);
        host.writeMemory(block + length, new Uint8Array(4));
        const hr = await callMethod(stream, SLOT_STREAM_READ, [block, length, block + length],
            thread);
        return hr < 0 || u32(read(block + length, 4)) !== length
            ? null
            : read(block, length).slice();
    });

    /**
     * A bitmap file out of the stream, as the DIB it holds: its headers say
     * how much colour table and how many bits follow. Only what the writer
     * writes is read -- an uncompressed DIB, or one with BI_BITFIELDS masks.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<import('./imagelist.js').Dib | null>}
     */
    const readDib = async(stream, thread)=>{
        const head = await readStream(stream, BITMAPFILEHEADER_SIZE + BITMAPINFOHEADER_SIZE,
            thread);
        if (!head)
        {
            return null;
        }
        const view = viewOf(head);
        const size = view.getUint32(BITMAPFILEHEADER_SIZE, true);
        const width = view.getInt32(BITMAPFILEHEADER_SIZE + 4, true);
        const height = view.getInt32(BITMAPFILEHEADER_SIZE + 8, true);
        const bitCount = view.getUint16(BITMAPFILEHEADER_SIZE + 14, true);
        const compression = view.getUint32(BITMAPFILEHEADER_SIZE + 16, true);
        const used = view.getUint32(BITMAPFILEHEADER_SIZE + 32, true);
        if (view.getUint16(0, true) !== BITMAP_MAGIC || size < BITMAPINFOHEADER_SIZE
            || size > BITMAPV5HEADER_SIZE || width <= 0 || height === 0
            || !DIB_BIT_COUNTS.has(bitCount)
            || (compression !== BI_RGB && compression !== BI_BITFIELDS))
        {
            return null;
        }
        let table = 0;
        if (bitCount <= 8)
        {
            table = (used > 0 && used < (1 << bitCount) ? used : 1 << bitCount) * 4;
        }
        else if (compression === BI_BITFIELDS && size === BITMAPINFOHEADER_SIZE)
        {
            table = 12;
        }
        const bits = ((width * bitCount + 31) >>> 5) * 4 * Math.abs(height);
        if (bits > MAX_DIB_BITS)
        {
            return null;
        }
        const extra = size - BITMAPINFOHEADER_SIZE + table;
        const rest = extra > 0 ? await readStream(stream, extra, thread) : new Uint8Array(0);
        const pixels = rest ? await readStream(stream, bits, thread) : null;
        if (!rest || !pixels)
        {
            return null;
        }
        const info = new Uint8Array(size + table);
        info.set(head.subarray(BITMAPFILEHEADER_SIZE));
        info.set(rest, BITMAPINFOHEADER_SIZE);
        return { info, bits: pixels };
    };

    /** @type {import('./imagelist.js').Scratch} */
    const scratch = {
        allocate: bytes=>host.allocate?.(bytes) ?? 0,
        release: address=>host.release?.(address),
    };

    return {
        /**
         * BOOL ImageList_Write(HIMAGELIST himl, LPSTREAM pstm)
         *
         * The header, the image and the mask, each with one call of the
         * stream's Write; FALSE for no list or no stream, or when the stream
         * refuses any of them.
         */
        ImageList_Write: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([handle, stream])=>{
                // Named before anything is awaited: past the first call into
                // the stream the thread on the processor is somebody else.
                const thread = host.callerThread?.();
                if ((stream >>> 0) === 0 || !ready('ImageList_Write'))
                {
                    return 0;
                }
                const saved = lists.save(handle >>> 0, TILE_COLUMNS, scratch);
                if (!saved)
                {
                    return 0;
                }
                const pieces = [headerBytes(saved.fields), bitmapFile(saved.image)];
                if (saved.mask)
                {
                    pieces.push(bitmapFile(saved.mask));
                }
                for (const piece of pieces)
                {
                    if (!(await writeStream(stream >>> 0, piece, thread)))
                    {
                        return 0;
                    }
                }
                return 1;
            },
        },

        /**
         * HIMAGELIST ImageList_Read(LPSTREAM pstm)
         *
         * A list made from what ImageList_Write wrote, read from where the
         * stream stands. A header that is not the 5.82 library's -- another
         * magic or version, no image size -- a bitmap that is not one, or a
         * stream that ends early answers NULL and makes no list.
         */
        ImageList_Read: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([stream])=>{
                const thread = host.callerThread?.();
                if ((stream >>> 0) === 0 || !ready('ImageList_Read'))
                {
                    return 0;
                }
                const head = await readStream(stream >>> 0, ILHEAD.SIZE, thread);
                if (!head)
                {
                    return 0;
                }
                const view = viewOf(head);
                const word = (/** @type {number} */ at)=>view.getUint16(at, true);
                const fields = {
                    count: word(ILHEAD.cCurImage), max: word(ILHEAD.cMaxImage),
                    grow: word(ILHEAD.cGrow), cx: word(ILHEAD.cx), cy: word(ILHEAD.cy),
                    background: view.getUint32(ILHEAD.bkcolor, true), flags: word(ILHEAD.flags),
                    overlays: [0, 1, 2, 3].map(index=>view.getInt16(ILHEAD.ovls + index * 2,
                        true)),
                };
                if (word(ILHEAD.usMagic) !== IMAGELIST_MAGIC
                    || word(ILHEAD.usVersion) !== IMAGELIST_VERSION
                    || fields.cx === 0 || fields.cy === 0)
                {
                    return 0;
                }
                const image = await readDib(stream >>> 0, thread);
                const masked = (fields.flags & ILC_MASK) !== 0;
                const mask = image && masked ? await readDib(stream >>> 0, thread) : null;
                if (!image || (masked && !mask))
                {
                    return 0;
                }
                return lists.restore(fields, image, mask, scratch);
            },
        },
    };
}

/**
 * The image list family's exports, the host's own lists when it built them,
 * and the two that move a list through a stream. Here rather than beside the
 * lists, so the lists know nothing of streams and the two files do not
 * import each other.
 *
 * @param {import('./imagelist.js').ImageListHost} host
 */
export function createImageListFunctions(host){
    const lists = host.imageLists ?? createImageLists(host);
    return { ...lists.functions, ...createImageListStreams(host, lists) };
}
