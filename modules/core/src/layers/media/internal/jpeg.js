/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A baseline JPEG decoder: what a texture library of this era hands its
 * decoder, and nothing more.
 *
 * Sequential Huffman coding (SOF0/SOF1), one to four components, any
 * sampling factors, restart intervals, 8-bit samples. Progressive and
 * arithmetic coding are refused rather than guessed at. The components come
 * out as they were coded, interleaved and in the frame's order: a texture
 * stored as four components is four channels the caller already knows the
 * meaning of, and a colour conversion here would be a guess about a file the
 * caller is about to interpret itself.
 *
 * Hosted because the program's own decoder runs as emulated x86 and takes a
 * noticeable share of the machine whenever textures arrive in a burst; the
 * arithmetic is the same, the cost is not.
 */

/**
 * @typedef {Object} DecodedJpeg
 * @property {number} width
 * @property {number} height
 * @property {number} components   1 to 4
 * @property {Uint8Array} samples  width * height * components, interleaved, top-down
 * @property {boolean} adobe       Whether an Adobe marker was present.
 * @property {number} transform    The Adobe transform flag (0 = none), when present.
 */

/** @typedef {{ width: number, height: number, components: number }} JpegHeader */

const ZIGZAG = Uint8Array.of(
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
    41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
    30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63);

/**
 * A Huffman table as the lookup the decoder walks: for each code length, the
 * first code of that length and the symbols in code order.
 *
 * @param {Uint8Array} counts   Sixteen counts, one per code length.
 * @param {Uint8Array} symbols  The symbols in order of increasing code.
 */
function buildHuffman(counts, symbols){
    /** @type {{ maxcode: Int32Array, valptr: Int32Array, mincode: Int32Array,
     *           symbols: Uint8Array }} */
    const table = {
        maxcode: new Int32Array(18).fill(-1),
        valptr: new Int32Array(17),
        mincode: new Int32Array(17),
        symbols,
    };
    let code = 0;
    let k = 0;
    for (let length = 1; length <= 16; length++)
    {
        const n = counts[length - 1];
        table.valptr[length] = k;
        table.mincode[length] = code;
        code += n;
        k += n;
        table.maxcode[length] = n > 0 ? code - 1 : -1;
        code <<= 1;
    }
    return table;
}

/** A reader over the entropy-coded segment: bits, with byte stuffing and markers honoured. */
class BitReader {
    /** @param {Uint8Array} bytes @param {number} at */
    constructor(bytes, at){
        this.bytes = bytes;
        this.at = at;
        this.bits = 0;
        this.count = 0;
        /** A marker met inside the segment; the segment ends there. */
        this.marker = 0;
    }

    /** @returns {number} the next bit, or zeroes once a marker was reached */
    bit(){
        if (this.count === 0)
        {
            if (this.marker !== 0 || this.at >= this.bytes.length)
            {
                // Past the end of the segment a decoder reads zero bits: this
                // is what lets a truncated scan finish rather than fault.
                return 0;
            }
            let byte = this.bytes[this.at++];
            if (byte === 0xff)
            {
                const next = this.bytes[this.at];
                if (next === 0)
                {
                    this.at++;
                }
                else
                {
                    // A marker: RSTn is consumed by the caller at a restart
                    // boundary, anything else ends the scan.
                    this.marker = next;
                    this.at--;
                    return 0;
                }
            }
            this.bits = byte;
            this.count = 8;
        }
        this.count--;
        return (this.bits >> this.count) & 1;
    }

    /** @param {number} n */
    receive(n){
        let value = 0;
        for (let i = 0; i < n; i++)
        {
            value = (value << 1) | this.bit();
        }
        return value;
    }

    /** @param {number} n */
    receiveExtend(n){
        if (n === 0)
        {
            return 0;
        }
        const value = this.receive(n);
        return value < (1 << (n - 1)) ? value - (1 << n) + 1 : value;
    }

    /** @param {ReturnType<typeof buildHuffman>} table */
    decode(table){
        let code = 0;
        for (let length = 1; length <= 16; length++)
        {
            code = (code << 1) | this.bit();
            if (table.maxcode[length] >= 0 && code <= table.maxcode[length]
                && code >= table.mincode[length])
            {
                return table.symbols[table.valptr[length] + code - table.mincode[length]];
            }
        }
        throw new Error('jpeg: a code no table has');
    }

    /** Drops the bits of the current byte and steps over an RSTn marker. */
    restart(){
        this.count = 0;
        // The marker may already have been met -- a decoder that read to the
        // end of the interval touched it -- or may still lie ahead, when the
        // interval ended with bits to spare in the last byte.
        if (this.marker >= 0xd0 && this.marker <= 0xd7)
        {
            this.at += 2;
            this.marker = 0;
        }
        else if (this.bytes[this.at] === 0xff && this.bytes[this.at + 1] >= 0xd0
            && this.bytes[this.at + 1] <= 0xd7)
        {
            this.at += 2;
        }
    }
}

/**
 * The inverse DCT of one block, separable and in floating point. Speed is not
 * the point of this decoder -- being off the emulated path is -- and a
 * straightforward transform is one whose correctness a test can check
 * against the definition.
 */
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++)
{
    for (let u = 0; u < 8; u++)
    {
        COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16);
    }
}

/**
 * @param {Int32Array} coefficients  64, in natural order, already dequantised.
 * @param {Float32Array} out         64 samples, row-major, unclamped, centred on zero.
 */
function inverseDct(coefficients, out){
    const rows = new Float32Array(64);
    for (let y = 0; y < 8; y++)
    {
        for (let x = 0; x < 8; x++)
        {
            let sum = 0;
            for (let u = 0; u < 8; u++)
            {
                sum += COS[x * 8 + u] * coefficients[y * 8 + u];
            }
            rows[y * 8 + x] = sum / 2;
        }
    }
    for (let x = 0; x < 8; x++)
    {
        for (let y = 0; y < 8; y++)
        {
            let sum = 0;
            for (let v = 0; v < 8; v++)
            {
                sum += COS[y * 8 + v] * rows[v * 8 + x];
            }
            out[y * 8 + x] = sum / 2;
        }
    }
}

/**
 * Only the frame header: the size and the component count, which a caller
 * asks for before it has anywhere to put the pixels.
 *
 * @param {Uint8Array} bytes
 * @returns {JpegHeader}
 */
export function readJpegHeader(bytes){
    return parse(bytes, true).header;
}

/**
 * @param {Uint8Array} bytes
 * @returns {DecodedJpeg}
 */
export function decodeJpeg(bytes){
    const { image } = parse(bytes, false);
    if (!image)
    {
        throw new Error('jpeg: no image');
    }
    return image;
}

/**
 * @param {Uint8Array} bytes
 * @param {boolean} headerOnly
 * @returns {{ header: JpegHeader, image: DecodedJpeg | null }}
 */
function parse(bytes, headerOnly){
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    {
        throw new Error('jpeg: not a JPEG stream');
    }
    /** @type {Uint8Array[]} */
    const quant = [];
    /** @type {ReturnType<typeof buildHuffman>[]} */
    const dcTables = [];
    /** @type {ReturnType<typeof buildHuffman>[]} */
    const acTables = [];
    /** @type {{ id: number, h: number, v: number, tq: number, blocksPerLine: number,
     *           blocksPerColumn: number, blocks: Int16Array, pred: number, td: number,
     *           ta: number, scanWidth: number, scanHeight: number }[]} */
    let components = [];
    let width = 0;
    let height = 0;
    let restartInterval = 0;
    let adobe = false;
    let transform = 0;
    let mcusPerLine = 0;
    let mcusPerColumn = 0;
    let hmax = 1;
    let vmax = 1;
    let at = 2;
    const u16 = (/** @type {number} */ p)=>(bytes[p] << 8) | bytes[p + 1];

    while (at < bytes.length)
    {
        if (bytes[at] !== 0xff)
        {
            at++;
            continue;
        }
        const marker = bytes[at + 1];
        at += 2;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
            || marker === 0xff)
        {
            if (marker === 0xff)
            {
                at--;
            }
            continue;
        }
        if (marker === 0xd9)
        {
            break;
        }
        const length = u16(at);
        const segment = at + 2;
        const end = at + length;
        switch (marker){
            case 0xdb: { // DQT
                let p = segment;
                while (p < end)
                {
                    const precision = bytes[p] >> 4;
                    const id = bytes[p] & 15;
                    p++;
                    const table = new Uint8Array(64);
                    for (let i = 0; i < 64; i++)
                    {
                        table[ZIGZAG[i]] = precision ? u16(p + i * 2) : bytes[p + i];
                    }
                    p += precision ? 128 : 64;
                    quant[id] = table;
                }
                break;
            }
            case 0xc4: { // DHT
                let p = segment;
                while (p < end)
                {
                    const cls = bytes[p] >> 4;
                    const id = bytes[p] & 15;
                    p++;
                    const counts = bytes.subarray(p, p + 16);
                    p += 16;
                    const total = counts.reduce((sum, n)=>sum + n, 0);
                    const symbols = bytes.slice(p, p + total);
                    p += total;
                    (cls === 0 ? dcTables : acTables)[id] = buildHuffman(counts, symbols);
                }
                break;
            }
            case 0xdd: // DRI
                restartInterval = u16(segment);
                break;
            case 0xee: // APP14, Adobe: says whether the components were transformed
                if (bytes[segment] === 0x41 && bytes[segment + 1] === 0x64)
                {
                    adobe = true;
                    transform = bytes[segment + 11];
                }
                break;
            case 0xc0: case 0xc1: { // SOF0 baseline, SOF1 extended sequential
                if (bytes[segment] !== 8)
                {
                    throw new Error('jpeg: only 8-bit samples');
                }
                height = u16(segment + 1);
                width = u16(segment + 3);
                const count = bytes[segment + 5];
                components = [];
                for (let i = 0; i < count; i++)
                {
                    const p = segment + 6 + i * 3;
                    components.push({
                        id: bytes[p], h: bytes[p + 1] >> 4, v: bytes[p + 1] & 15, tq: bytes[p + 2],
                        blocksPerLine: 0, blocksPerColumn: 0, blocks: new Int16Array(0),
                        pred: 0, td: 0, ta: 0, scanWidth: 0, scanHeight: 0,
                    });
                }
                if (headerOnly)
                {
                    return { header: { width, height, components: count }, image: null };
                }
                hmax = Math.max(...components.map(c=>c.h));
                vmax = Math.max(...components.map(c=>c.v));
                mcusPerLine = Math.ceil(width / (8 * hmax));
                mcusPerColumn = Math.ceil(height / (8 * vmax));
                for (const c of components)
                {
                    c.blocksPerLine = mcusPerLine * c.h;
                    c.blocksPerColumn = mcusPerColumn * c.v;
                    // The component's own extent, which a scan of it alone walks
                    // block by block rather than by the frame's MCU grid.
                    c.scanWidth = Math.ceil(width * c.h / hmax);
                    c.scanHeight = Math.ceil(height * c.v / vmax);
                    c.blocks = new Int16Array(c.blocksPerLine * c.blocksPerColumn * 64);
                }
                break;
            }
            case 0xc2: case 0xc3: case 0xc5: case 0xc6: case 0xc7:
            case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
                throw new Error('jpeg: only sequential Huffman coding');
            case 0xda: { // SOS
                if (components.length === 0)
                {
                    throw new Error('jpeg: a scan before the frame');
                }
                const count = bytes[segment];
                /** @type {typeof components} */
                const scan = [];
                for (let i = 0; i < count; i++)
                {
                    const id = bytes[segment + 1 + i * 2];
                    const tables = bytes[segment + 2 + i * 2];
                    const c = components.find(entry=>entry.id === id);
                    if (!c)
                    {
                        throw new Error('jpeg: a scan of a component the frame lacks');
                    }
                    c.td = tables >> 4;
                    c.ta = tables & 15;
                    c.pred = 0;
                    scan.push(c);
                }
                const reader = new BitReader(bytes, end);
                decodeScan(reader, scan, components.length === scan.length && scan.length > 1,
                    { mcusPerLine, mcusPerColumn, restartInterval, dcTables, acTables });
                at = reader.at;
                continue;
            }
            default:
                break;
        }
        at = end;
    }

    if (components.length === 0)
    {
        throw new Error('jpeg: no frame');
    }
    return {
        header: { width, height, components: components.length },
        image: assemble(components, quant, width, height, hmax, vmax, adobe, transform),
    };
}

/**
 * One scan's entropy-coded data into the components' coefficient blocks.
 *
 * @param {BitReader} reader
 * @param {any[]} scan
 * @param {boolean} interleaved
 * @param {{ mcusPerLine: number, mcusPerColumn: number, restartInterval: number,
 *           dcTables: any[], acTables: any[] }} frame
 */
function decodeScan(reader, scan, interleaved, frame){
    const { mcusPerLine, mcusPerColumn, restartInterval, dcTables, acTables } = frame;

    /** @param {any} c @param {number} row @param {number} column */
    const decodeBlock = (c, row, column)=>{
        const dc = dcTables[c.td];
        const ac = acTables[c.ta];
        if (!dc || !ac)
        {
            throw new Error('jpeg: a scan without its tables');
        }
        const offset = (row * c.blocksPerLine + column) * 64;
        const blocks = c.blocks;
        const t = reader.decode(dc);
        c.pred += reader.receiveExtend(t);
        blocks[offset] = c.pred;
        for (let k = 1; k < 64;)
        {
            const rs = reader.decode(ac);
            const s = rs & 15;
            const r = rs >> 4;
            if (s === 0)
            {
                if (r < 15)
                {
                    break; // end of block
                }
                k += 16;
                continue;
            }
            k += r;
            if (k > 63)
            {
                break;
            }
            blocks[offset + ZIGZAG[k]] = reader.receiveExtend(s);
            k++;
        }
    };

    let mcu = 0;
    const total = mcusPerLine * mcusPerColumn;
    if (interleaved)
    {
        while (mcu < total)
        {
            const row = Math.floor(mcu / mcusPerLine);
            const column = mcu % mcusPerLine;
            for (const c of scan)
            {
                for (let v = 0; v < c.v; v++)
                {
                    for (let h = 0; h < c.h; h++)
                    {
                        decodeBlock(c, row * c.v + v, column * c.h + h);
                    }
                }
            }
            mcu++;
            if (restartInterval && mcu % restartInterval === 0 && mcu < total)
            {
                reader.restart();
                for (const c of scan)
                {
                    c.pred = 0;
                }
            }
        }
        return;
    }
    // A non-interleaved scan covers one component, block by block over its
    // own dimensions rather than the MCU grid.
    const c = scan[0];
    const rows = Math.ceil(c.scanHeight / 8);
    const columns = Math.ceil(c.scanWidth / 8);
    let n = 0;
    for (let row = 0; row < rows; row++)
    {
        for (let column = 0; column < columns; column++)
        {
            decodeBlock(c, row, column);
            n++;
            if (restartInterval && n % restartInterval === 0 && n < rows * columns)
            {
                reader.restart();
                c.pred = 0;
            }
        }
    }
}

/**
 * Dequantises, transforms and interleaves every component into one buffer.
 *
 * @param {any[]} components @param {Uint8Array[]} quant
 * @param {number} width @param {number} height @param {number} hmax @param {number} vmax
 * @param {boolean} adobe @param {number} transform
 * @returns {DecodedJpeg}
 */
function assemble(components, quant, width, height, hmax, vmax, adobe, transform){
    const count = components.length;
    const samples = new Uint8Array(width * height * count);
    const coefficients = new Int32Array(64);
    const block = new Float32Array(64);
    components.forEach((c, index)=>{
        const q = quant[c.tq];
        if (!q)
        {
            throw new Error('jpeg: a component without its quantisation table');
        }
        // The component's own plane, then sampled up to the frame's grid.
        const planeWidth = c.blocksPerLine * 8;
        const planeHeight = c.blocksPerColumn * 8;
        const plane = new Uint8Array(planeWidth * planeHeight);
        for (let row = 0; row < c.blocksPerColumn; row++)
        {
            for (let column = 0; column < c.blocksPerLine; column++)
            {
                const offset = (row * c.blocksPerLine + column) * 64;
                for (let i = 0; i < 64; i++)
                {
                    coefficients[i] = c.blocks[offset + i] * q[i];
                }
                inverseDct(coefficients, block);
                for (let y = 0; y < 8; y++)
                {
                    for (let x = 0; x < 8; x++)
                    {
                        const value = Math.round(block[y * 8 + x] + 128);
                        plane[(row * 8 + y) * planeWidth + column * 8 + x] =
                            value < 0 ? 0 : value > 255 ? 255 : value;
                    }
                }
            }
        }
        const sx = c.h / hmax;
        const sy = c.v / vmax;
        for (let y = 0; y < height; y++)
        {
            const py = Math.floor(y * sy);
            for (let x = 0; x < width; x++)
            {
                samples[(y * width + x) * count + index] =
                    plane[py * planeWidth + Math.floor(x * sx)];
            }
        }
    });
    return { width, height, components: count, samples, adobe, transform };
}
