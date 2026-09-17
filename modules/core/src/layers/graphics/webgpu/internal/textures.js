/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture upload, by the path that survives a paravirtualised driver chain.
 *
 * A direct write into a texture is spec-correct and raises no validation error,
 * and along a "VM -> translation -> driver" chain the bytes can still fail to
 * arrive: the texture then samples as empty, and nothing anywhere reports it.
 * The path that works is a staging buffer plus a buffer-to-texture copy, with
 * the rows repacked to the pitch alignment that copy demands. That is the
 * default for block-compressed formats, where the failure was observed, and is
 * available for any format.
 *
 * The other half of the same lesson: a "no error" from a graphics call is not a
 * report of success. Only reading pixels back proves anything.
 *
 * Row geometry is counted in blocks, never in pixels. A function that assumes
 * four bytes per pixel gives a confident wrong answer for every compressed
 * format -- the same arithmetic mistake that makes a diagnostic read of a
 * compressed texture report a false zero.
 */

/** `copyBufferToTexture` requires the source pitch to be a multiple of this. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/**
 * Block size by BC family (the part of the name before the first dash) or, for
 * the ETC2/EAC set, by the whole format name.
 *
 * @type {Record<string, number>}
 */
const COMPRESSED_BLOCK_BYTES = {
    bc1: 8,
    bc4: 8,
    bc2: 16,
    bc3: 16,
    bc5: 16,
    bc6h: 16,
    bc7: 16,
    'etc2-rgb8unorm': 8,
    'etc2-rgb8unorm-srgb': 8,
    'etc2-rgb8a1unorm': 8,
    'etc2-rgb8a1unorm-srgb': 8,
    'etc2-rgba8unorm': 16,
    'etc2-rgba8unorm-srgb': 16,
    'eac-r11unorm': 8,
    'eac-r11snorm': 8,
    'eac-rg11unorm': 16,
    'eac-rg11snorm': 16,
};

/** @type {Record<string, number>} */
const UNCOMPRESSED_PIXEL_BYTES = {
    r8unorm: 1,
    r8snorm: 1,
    r8uint: 1,
    r8sint: 1,
    r16uint: 2,
    r16sint: 2,
    r16float: 2,
    rg8unorm: 2,
    rg8snorm: 2,
    rg8uint: 2,
    rg8sint: 2,
    r32float: 4,
    r32uint: 4,
    r32sint: 4,
    rg16uint: 4,
    rg16sint: 4,
    rg16float: 4,
    rgba8unorm: 4,
    'rgba8unorm-srgb': 4,
    rgba8snorm: 4,
    rgba8uint: 4,
    rgba8sint: 4,
    bgra8unorm: 4,
    'bgra8unorm-srgb': 4,
    rgb10a2unorm: 4,
    rg11b10ufloat: 4,
    rg32float: 8,
    rg32uint: 8,
    rg32sint: 8,
    rgba16uint: 8,
    rgba16sint: 8,
    rgba16float: 8,
    rgba32float: 16,
    rgba32uint: 16,
    rgba32sint: 16,
};

/**
 * @param {string} format
 * @returns {{ blockWidth: number, blockHeight: number, bytesPerBlock: number,
 *             compressed: boolean }}
 */
export function blockInfo(format){
    const astc = /^astc-(\d+)x(\d+)-/.exec(format);
    if (astc)
    {
        // Every ASTC block is 16 bytes; only the footprint changes.
        return {
            blockWidth: Number(astc[1]),
            blockHeight: Number(astc[2]),
            bytesPerBlock: 16,
            compressed: true,
        };
    }
    const bytes = COMPRESSED_BLOCK_BYTES[format.split('-')[0]] || COMPRESSED_BLOCK_BYTES[format];
    if (bytes)
    {
        return { blockWidth: 4, blockHeight: 4, bytesPerBlock: bytes, compressed: true };
    }
    const pixel = UNCOMPRESSED_PIXEL_BYTES[format];
    if (!pixel)
    {
        throw new Error(`Unknown format "${format}": cannot compute its row pitch`);
    }
    return { blockWidth: 1, blockHeight: 1, bytesPerBlock: pixel, compressed: false };
}

/**
 * Copies each row to an aligned pitch, leaving the padding zeroed.
 *
 * @param {Uint8Array} data
 * @param {{ rows: number, bytesPerRow: number, alignedBytesPerRow: number,
 *           offset?: number }} layout
 * @returns {Uint8Array}
 */
export function repackRows(data, layout){
    const offset = layout.offset === undefined ? 0 : layout.offset;
    const packed = new Uint8Array(layout.rows * layout.alignedBytesPerRow);
    for (let row = 0; row < layout.rows; row++)
    {
        const from = offset + row * layout.bytesPerRow;
        packed.set(data.subarray(from, from + layout.bytesPerRow), row * layout.alignedBytesPerRow);
    }
    return packed;
}

/**
 * @param {Object} options
 * @param {import('../contract.js').GpuDeviceLike} options.device
 * @param {import('../contract.js').GpuQueueLike} options.queue
 * @param {(source: any, destination: any, size: any)=>void} options.encodeCopy
 * @param {number} [options.stagingUsage]
 * @param {(record: any)=>void} [options.onUpload]
 * @returns {(request: any)=>void}
 */
export function createTextureUploader(options){
    return function upload(request){
        const info = blockInfo(request.format);
        const columns = Math.ceil(request.width / info.blockWidth);
        const rows = Math.ceil(request.height / info.blockHeight);
        const bytesPerRow = request.bytesPerRow === undefined
            ? columns * info.bytesPerBlock
            : request.bytesPerRow;
        const needed = rows * bytesPerRow;
        const data = request.data;
        if (data.byteLength < needed)
        {
            throw new Error(
                `A ${request.width}x${request.height} ${request.format} upload needs`
                + ` ${needed} bytes, got ${data.byteLength}`);
        }
        if (request.staging === false && info.compressed)
        {
            throw new Error(
                `A compressed upload (${request.format}) must go through a staging buffer:`
                + ' a direct write can be dropped with no error raised');
        }
        const origin = {
            x: request.origin ? request.origin.x : 0,
            y: request.origin ? request.origin.y : 0,
            z: request.origin && request.origin.z ? request.origin.z : 0,
        };
        const destination = {
            texture: request.texture,
            mipLevel: request.mipLevel === undefined ? 0 : request.mipLevel,
            origin,
            aspect: 'all',
        };
        // The copy's extent, not the level's logical size: WebGPU's texture-copy
        // validation compares against the physical size of a compressed
        // subresource, which is the logical size rounded up to a whole block,
        // and a tail mip smaller than one block is refused otherwise
        // ("copySize.width is not a multiple of ... block width").
        const size = {
            width: info.compressed ? columns * info.blockWidth : request.width,
            height: info.compressed ? rows * info.blockHeight : request.height,
            depthOrArrayLayers: request.depthOrArrayLayers === undefined
                ? 1
                : request.depthOrArrayLayers,
        };

        const staged = request.staging === undefined ? info.compressed : request.staging;
        if (!staged)
        {
            options.queue.writeTexture(destination, data,
                { offset: 0, bytesPerRow, rowsPerImage: rows }, size);
            if (options.onUpload)
            {
                options.onUpload({ staged: false, bytes: needed, format: request.format });
            }
            return;
        }

        const alignedBytesPerRow = Math.ceil(bytesPerRow / COPY_BYTES_PER_ROW_ALIGNMENT)
            * COPY_BYTES_PER_ROW_ALIGNMENT;
        const packed = repackRows(data, { rows, bytesPerRow, alignedBytesPerRow });
        const staging = options.device.createBuffer({
            label: `staging:${request.format}`,
            size: packed.byteLength,
            usage: options.stagingUsage,
        });
        options.queue.writeBuffer(staging, 0, packed, 0, packed.byteLength);
        options.encodeCopy(
            { buffer: staging, offset: 0, bytesPerRow: alignedBytesPerRow, rowsPerImage: rows },
            destination,
            size);
        if (options.onUpload)
        {
            options.onUpload({ staged: true, bytes: packed.byteLength, format: request.format });
        }
    };
}
