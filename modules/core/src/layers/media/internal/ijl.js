/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Intel JPEG Library, as the redistributable a program ships beside itself:
 * `ijl15.dll`, six exports, one structure.
 *
 * A program of this era decodes its textures through this library, and run
 * as guest code the decoder took a noticeable share of the machine whenever
 * textures arrived in a burst -- which is exactly when a game has the least
 * time to spare. Hosted, the same pictures come out of a decoder that is not
 * being emulated. The contract is the library's published one: a caller fills
 * JPEG_CORE_PROPERTIES, asks for the parameters of a buffer, sizes a DIB,
 * asks for the whole image into it.
 *
 * The structure, as the header lays it out (offsets in bytes):
 *
 *      0  UseJPEGPROPERTIES       32  JPGWidth           64  JPGBytes
 *      4  DIBWidth                36  JPGHeight          68  JPGSizeBytes
 *      8  DIBHeight               40  JPGColor           72  jquality
 *     12  DIBPadBytes             44  JPGChannels        76  jprops...
 *     16  DIBColor                48  JPGSubsampling
 *     20  DIBChannels             52  JPGThumbWidth
 *     24  DIBSubsampling          56  JPGThumbHeight
 *     28  DIBBytes                60  JPGFile
 *
 * A negative DIBHeight is a top-down DIB; a positive one is bottom-up, as
 * Windows has it. Colour: the library converts YCbCr to RGB or BGR when the
 * caller asks for either; anything else -- and a four-component picture in
 * particular -- is handed over as the components lie, which is what a
 * texture format that stores its own channels wants.
 */

import { decodeJpeg, readJpegHeader } from './jpeg.js';

const OFFSET = {
    // The first word says whether the caller filled in the detailed
    // properties that follow the core ones; the core ones are laid out with
    // the channel count ahead of the colour space on both sides, which is
    // how a program compiled against the library's own header fills them.
    UseJPEGPROPERTIES: 0,
    DIBBytes: 4, DIBWidth: 8, DIBHeight: 12, DIBPadBytes: 16, DIBChannels: 20, DIBColor: 24,
    DIBSubsampling: 28,
    JPGFile: 32, JPGBytes: 36, JPGSizeBytes: 40, JPGWidth: 44, JPGHeight: 48, JPGChannels: 52,
    JPGColor: 56, JPGSubsampling: 60, JPGThumbWidth: 64, JPGThumbHeight: 68,
    jquality: 72,
};

/** IJL_COLOR. */
const COLOR = { RGB: 1, BGR: 2, YCBCR: 3, G: 4, RGBA_FPX: 5, YCBCRA_FPX: 6, OTHER: 255 };
/** IJL_JPGSUBSAMPLING. */
const SUBSAMPLING = { NONE: 0, S411: 1, S422: 2, S4114: 3, S4224: 4 };
/** IJLIOTYPE: what ijlRead is asked for. */
const IO = {
    JFILE_READPARAMS: 0, JBUFF_READPARAMS: 1, JFILE_READWHOLEIMAGE: 2, JBUFF_READWHOLEIMAGE: 3,
    JFILE_READHEADER: 4, JBUFF_READHEADER: 5, JFILE_READENTROPY: 6, JBUFF_READENTROPY: 7,
};
/** IJLERR. */
export const IJL = {
    OK: 0,
    EXCEPTION_DETECTED: -1, INVALID_ENCODER: -2, UNSUPPORTED_SUBSAMPLING: -3,
    UNSUPPORTED_BYTES_PER_PIXEL: -4, MEMORY_ERROR: -5, BAD_HUFFMAN_TABLE: -6,
    BAD_QUANT_TABLE: -7, INVALID_JPEG_PROPERTIES: -8, INVALID_FILENAME: -10,
    ERROR_EOF: -11, PROGRESSIVE_UNSUPPORTED: -12, ERR_DATA: -19, ERR_NO_IMAGE: -20,
    FILE_ERROR: -21, INTERNAL_ERROR: -22, BUFFER_TOO_SMALL: -26, UNSUPPORTED_FRAME: -27,
};

const ERROR_TEXT = {
    [IJL.OK]: 'IJL_OK',
    [IJL.INVALID_ENCODER]: 'IJL_INVALID_ENCODER',
    [IJL.UNSUPPORTED_SUBSAMPLING]: 'IJL_UNSUPPORTED_SUBSAMPLING',
    [IJL.UNSUPPORTED_BYTES_PER_PIXEL]: 'IJL_UNSUPPORTED_BYTES_PER_PIXEL',
    [IJL.INVALID_JPEG_PROPERTIES]: 'IJL_INVALID_JPEG_PROPERTIES',
    [IJL.PROGRESSIVE_UNSUPPORTED]: 'IJL_PROGRESSIVE_UNSUPPORTED',
    [IJL.ERR_DATA]: 'IJL_ERR_DATA',
    [IJL.ERR_NO_IMAGE]: 'IJL_ERR_NO_IMAGE',
    [IJL.FILE_ERROR]: 'IJL_FILE_ERROR',
    [IJL.INTERNAL_ERROR]: 'IJL_INTERNAL_ERROR',
    [IJL.BUFFER_TOO_SMALL]: 'IJL_BUFFER_TOO_SMALL',
};

/** The exports by ordinal, as the shipped library numbers them. */
export const IJL_ORDINALS = {
    1: 'ijlGetLibVersion', 2: 'ijlInit', 3: 'ijlFree', 4: 'ijlRead', 5: 'ijlWrite',
    6: 'ijlErrorStr',
};

/**
 * @param {Object} deps
 * @param {(address: number, length: number) => Uint8Array} deps.readMemory
 * @param {(address: number, bytes: Uint8Array) => void} deps.writeMemory
 * @param {(bytes: number) => number} deps.allocate
 *        Guest memory for the strings the library hands out.
 * @param {(message: string) => void} [deps.warn]
 */
export function createIjlLibrary({ readMemory, writeMemory, allocate, warn }){
    const u32 = (/** @type {number} */ address)=>{
        const b = readMemory(address, 4);
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    };
    const i32 = (/** @type {number} */ address)=>u32(address) | 0;
    const put32 = (/** @type {number} */ address, /** @type {number} */ value)=>
        writeMemory(address, Uint8Array.of(value & 0xff, (value >>> 8) & 0xff,
            (value >>> 16) & 0xff, (value >>> 24) & 0xff));

    /** @type {Map<number, string>} strings handed to the program, once each */
    const strings = new Map();
    const stringAt = (/** @type {string} */ text)=>{
        for (const [address, held] of strings)
        {
            if (held === text)
            {
                return address;
            }
        }
        const bytes = new TextEncoder().encode(`${text}\0`);
        const address = allocate(bytes.length);
        if (address !== 0)
        {
            writeMemory(address, bytes);
            strings.set(address, text);
        }
        return address;
    };
    /** @type {number} the IJLibVersion structure, laid out once */
    let version = 0;

    /**
     * What the library remembers per structure between the call that reads
     * the parameters and the one that reads the image: the parsed header, and
     * the picture once it has been decoded.
     *
     * @type {Map<number, { header: import('./jpeg.js').JpegHeader | null }>}
     */
    const open = new Map();

    let decoded = 0;
    let failed = 0;
    let decodeMs = 0;

    /** @param {number} props @returns {Uint8Array | null} */
    const jpegBytes = props=>{
        const bytes = u32(props + OFFSET.JPGBytes);
        const size = u32(props + OFFSET.JPGSizeBytes);
        if (bytes === 0 || size === 0)
        {
            return null;
        }
        return readMemory(bytes, size);
    };

    /**
     * Fills the JPG side of the structure from a parsed header.
     *
     * @param {number} props @param {import('./jpeg.js').JpegHeader} header
     */
    const describe = (props, header)=>{
        put32(props + OFFSET.JPGWidth, header.width);
        put32(props + OFFSET.JPGHeight, header.height);
        put32(props + OFFSET.JPGChannels, header.components);
        // One component is grey and three are YCbCr, as the library assumes
        // without an Adobe marker to say otherwise; four are the caller's own.
        put32(props + OFFSET.JPGColor, header.components === 1 ? COLOR.G
            : header.components === 3 ? COLOR.YCBCR : COLOR.OTHER);
        put32(props + OFFSET.JPGSubsampling, SUBSAMPLING.NONE);
    };

    /**
     * The picture into the caller's DIB, in the layout the DIB fields ask for.
     *
     * @param {number} props @param {import('./jpeg.js').DecodedJpeg} image
     * @returns {number} an IJLERR
     */
    const deliver = (props, image)=>{
        const dib = u32(props + OFFSET.DIBBytes);
        const width = u32(props + OFFSET.DIBWidth);
        const signedHeight = i32(props + OFFSET.DIBHeight);
        const height = Math.abs(signedHeight);
        const pad = u32(props + OFFSET.DIBPadBytes);
        const channels = u32(props + OFFSET.DIBChannels);
        const color = u32(props + OFFSET.DIBColor);
        if (dib === 0 || width === 0 || height === 0 || channels === 0)
        {
            return IJL.INVALID_JPEG_PROPERTIES;
        }
        const w = Math.min(width, image.width);
        const h = Math.min(height, image.height);
        const stride = width * channels + pad;
        const out = new Uint8Array(stride * height);
        const src = image.samples;
        const n = image.components;
        // The channels the DIB wants from the ones the picture has: a colour
        // conversion only when the picture is YCbCr and the caller asked for
        // RGB or BGR; otherwise the components as they lie, padded or cut to
        // the channel count asked for.
        const convert = n === 3 && (color === COLOR.RGB || color === COLOR.BGR)
            && (!image.adobe || image.transform === 1);
        const swap = color === COLOR.BGR && (convert || (n === 3 && !image.adobe));
        const pixel = new Uint8Array(4);
        for (let y = 0; y < h; y++)
        {
            // Rows land in the picture's own order for the usual positive
            // height: a program compiled against the library reads its
            // texture atlas that way, and one delivered upside down picks
            // the wrong cells out of it. A negative height asks for the
            // rows reversed.
            const row = signedHeight < 0 ? height - 1 - y : y;
            for (let x = 0; x < w; x++)
            {
                const at = (y * image.width + x) * n;
                if (convert)
                {
                    const Y = src[at];
                    const cb = src[at + 1] - 128;
                    const cr = src[at + 2] - 128;
                    pixel[0] = clamp(Y + 1.402 * cr);
                    pixel[1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
                    pixel[2] = clamp(Y + 1.772 * cb);
                    pixel[3] = 255;
                }
                else
                {
                    for (let c = 0; c < 4; c++)
                    {
                        pixel[c] = c < n ? src[at + c] : 255;
                    }
                }
                if (swap)
                {
                    const r = pixel[0];
                    pixel[0] = pixel[2];
                    pixel[2] = r;
                }
                const to = row * stride + x * channels;
                for (let c = 0; c < channels; c++)
                {
                    out[to + c] = c < 4 ? pixel[c] : 255;
                }
            }
        }
        writeMemory(dib, out);
        return IJL.OK;
    };

    /**
     * @param {number} props @param {number} iotype
     * @returns {number}
     */
    const read = (props, iotype)=>{
        if (props === 0)
        {
            return IJL.INVALID_JPEG_PROPERTIES;
        }
        switch (iotype){
            case IO.JBUFF_READPARAMS:
            case IO.JBUFF_READHEADER: {
                const bytes = jpegBytes(props);
                if (!bytes)
                {
                    return IJL.INVALID_JPEG_PROPERTIES;
                }
                try
                {
                    const header = readJpegHeader(bytes);
                    describe(props, header);
                    open.set(props, { header });
                    return IJL.OK;
                }
                catch (e){
                    failed++;
                    warn?.(`ijl: ${e instanceof Error ? e.message : String(e)}`);
                    return /sequential/.test(String(e)) ? IJL.PROGRESSIVE_UNSUPPORTED : IJL.ERR_DATA;
                }
            }
            case IO.JBUFF_READWHOLEIMAGE:
            case IO.JBUFF_READENTROPY: {
                const bytes = jpegBytes(props);
                if (!bytes)
                {
                    return IJL.INVALID_JPEG_PROPERTIES;
                }
                const started = performance.now();
                try
                {
                    const image = decodeJpeg(bytes);
                    describe(props, image);
                    const result = deliver(props, image);
                    decoded++;
                    return result;
                }
                catch (e){
                    failed++;
                    warn?.(`ijl: ${e instanceof Error ? e.message : String(e)}`);
                    return /sequential/.test(String(e)) ? IJL.PROGRESSIVE_UNSUPPORTED : IJL.ERR_DATA;
                }
                finally
                {
                    decodeMs += performance.now() - started;
                }
            }
            case IO.JFILE_READPARAMS:
            case IO.JFILE_READWHOLEIMAGE:
            case IO.JFILE_READHEADER:
            case IO.JFILE_READENTROPY:
                // Files are read by name through the C runtime in the real
                // library; nothing here reaches a volume, and a program that
                // wants that is told so rather than handed a blank picture.
                warn?.('ijl: reading a JPEG by file name is not supported');
                return IJL.FILE_ERROR;
            default:
                return IJL.INVALID_JPEG_PROPERTIES;
        }
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
    const library = {
        /** IJLibVersion* ijlGetLibVersion(void) */
        ijlGetLibVersion: {
            argBytes: 0,
            handler: ()=>{
                if (version === 0)
                {
                    // DWORD major, minor, build; LPCSTR Name, Version,
                    // InternalVersion, BuildDate, CallConv.
                    version = allocate(8 * 4);
                    if (version !== 0)
                    {
                        put32(version, 1);
                        put32(version + 4, 5);
                        put32(version + 8, 1);
                        put32(version + 12, stringAt('Intel(R) JPEG Library'));
                        put32(version + 16, stringAt('1.5.1'));
                        put32(version + 20, stringAt('1.5.1.1'));
                        put32(version + 24, stringAt(''));
                        put32(version + 28, stringAt('DLL'));
                    }
                }
                return version;
            },
        },
        /** IJLERR ijlInit(JPEG_CORE_PROPERTIES* jcprops) */
        ijlInit: {
            argBytes: 4,
            handler: ([props])=>{
                if ((props >>> 0) === 0)
                {
                    return IJL.INVALID_JPEG_PROPERTIES;
                }
                // The DIB and JPEG halves start empty and the quality at the
                // library's default; a caller reads back what it did not set.
                writeMemory(props >>> 0, new Uint8Array(OFFSET.jquality + 4));
                put32((props >>> 0) + OFFSET.jquality, 75);
                open.set(props >>> 0, { header: null });
                return IJL.OK;
            },
        },
        /** IJLERR ijlFree(JPEG_CORE_PROPERTIES* jcprops) */
        ijlFree: {
            argBytes: 4,
            handler: ([props])=>{
                open.delete(props >>> 0);
                return IJL.OK;
            },
        },
        /** IJLERR ijlRead(JPEG_CORE_PROPERTIES* jcprops, IJLIOTYPE iotype) */
        ijlRead: {
            argBytes: 8,
            handler: ([props, iotype])=>read(props >>> 0, iotype | 0),
        },
        /** IJLERR ijlWrite(JPEG_CORE_PROPERTIES* jcprops, IJLIOTYPE iotype) */
        ijlWrite: {
            argBytes: 8,
            handler: ()=>{
                warn?.('ijl: encoding is not supported');
                return IJL.INVALID_ENCODER;
            },
        },
        /** const char* ijlErrorStr(IJLERR code) */
        ijlErrorStr: {
            argBytes: 4,
            handler: ([code])=>stringAt(ERROR_TEXT[code | 0] ?? `IJL error ${code | 0}`),
        },
    };

    return {
        libraries: { 'ijl15.dll': library },
        ordinals: { 'ijl15.dll': IJL_ORDINALS },
        diagnostics: ()=>({ decoded, failed, decodeMs: Math.round(decodeMs), open: open.size }),
    };
}

/** @param {number} value */
const clamp = value=>(value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
