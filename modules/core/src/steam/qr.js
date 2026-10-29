/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * QR codes, as ISO/IEC 18004 describes them, for the short URL a sign-in
 * shows: byte mode, error correction level M, versions 1 to 10 (up to 213
 * bytes). The mask is chosen by the standard's penalty rules.
 */

/**
 * Codewords per version at level M: the error-correction codewords of each
 * block, and the blocks with their data codewords.
 *
 * @type {Array<[number, number[]]>}
 */
const VERSIONS_M = [
    [0, []],
    [10, [16]],
    [16, [28]],
    [26, [44]],
    [18, [32, 32]],
    [24, [43, 43]],
    [16, [27, 27, 27, 27]],
    [18, [31, 31, 31, 31]],
    [22, [38, 38, 39, 39]],
    [22, [36, 36, 36, 37, 37]],
    [26, [43, 43, 43, 43, 44]],
];

/** Where the alignment patterns are centred, per version. */
const ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** The error-correction level's two bits in the format information. */
const LEVEL_M = 0b00;

// GF(256) over x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++)
{
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100)
    {
        x ^= 0x11D;
    }
}
for (let i = 255; i < 512; i++)
{
    EXP[i] = EXP[i - 255];
}
/** @param {number} a @param {number} b */
const multiply = (a, b)=>(a && b ? EXP[LOG[a] + LOG[b]] : 0);

/**
 * The Reed-Solomon error-correction codewords of a block.
 *
 * @param {Uint8Array | number[]} data
 * @param {number} count
 * @returns {Uint8Array}
 */
export function reedSolomon(data, count){
    // The generator: the product of (x - a^i) for i below count, highest
    // coefficient first and left out (it is 1).
    let generator = [1];
    for (let i = 0; i < count; i++)
    {
        const next = new Array(generator.length + 1).fill(0);
        for (let j = 0; j < generator.length; j++)
        {
            next[j] ^= generator[j];
            next[j + 1] ^= multiply(generator[j], EXP[i]);
        }
        generator = next;
    }
    const remainder = new Uint8Array(count);
    for (const byte of data)
    {
        const factor = byte ^ remainder[0];
        remainder.copyWithin(0, 1);
        remainder[count - 1] = 0;
        for (let j = 0; j < count; j++)
        {
            remainder[j] ^= multiply(generator[j + 1], factor);
        }
    }
    return remainder;
}

/**
 * A BCH code's remainder, for the format and version information.
 *
 * @param {number} value @param {number} generator @param {number} degree
 */
const bch = (value, generator, degree)=>{
    let remainder = value << degree;
    for (let bit = 31 - Math.clz32(remainder); bit >= degree; bit--)
    {
        if (remainder & (1 << bit))
        {
            remainder ^= generator << (bit - degree);
        }
    }
    return (value << degree) | remainder;
};

/** The 15 format bits for a mask at level M. @param {number} mask */
export const formatBits = mask=>bch((LEVEL_M << 3) | mask, 0x537, 10) ^ 0x5412;

/** The 18 version bits, for version 7 and up. @param {number} version */
export const versionBits = version=>bch(version, 0x1F25, 12);

/**
 * Where each of the 15 format bits goes, twice: around the top-left finder,
 * and split between the other two.
 *
 * @param {number} size
 * @returns {Array<[number, number, number]>}  x, y and the bit's index.
 */
function formatPositions(size){
    /** @type {Array<[number, number, number]>} */
    const cells = [];
    for (let i = 0; i <= 5; i++)
    {
        cells.push([8, i, i]);
    }
    cells.push([8, 7, 6], [8, 8, 7], [7, 8, 8]);
    for (let i = 9; i < 15; i++)
    {
        cells.push([14 - i, 8, i]);
    }
    for (let i = 0; i < 8; i++)
    {
        cells.push([size - 1 - i, 8, i]);
    }
    for (let i = 8; i < 15; i++)
    {
        cells.push([8, size - 15 + i, i]);
    }
    return cells;
}

/** @type {Array<(x: number, y: number) => boolean>} */
const MASKS = [
    (x, y)=>(x + y) % 2 === 0,
    (x, y)=>y % 2 === 0,
    x=>x % 3 === 0,
    (x, y)=>(x + y) % 3 === 0,
    (x, y)=>(Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y)=>((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y)=>(((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y)=>(((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The data and error-correction codewords in the order they are placed.
 *
 * @param {Uint8Array} bytes @param {number} version
 */
function codewords(bytes, version){
    const [ecCount, blocks] = VERSIONS_M[version];
    const capacity = blocks.reduce((sum, n)=>sum + n, 0);
    /** @type {number[]} */
    const bits = [];
    /** @param {number} value @param {number} length */
    const put = (value, length)=>{
        for (let bit = length - 1; bit >= 0; bit--)
        {
            bits.push((value >>> bit) & 1);
        }
    };
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes)
    {
        put(byte, 8);
    }
    put(0, Math.min(4, capacity * 8 - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    const data = [];
    for (let at = 0; at < bits.length; at += 8)
    {
        data.push(bits.slice(at, at + 8).reduce((byte, bit)=>(byte << 1) | bit, 0));
    }
    for (let pad = 0; data.length < capacity; pad ^= 1)
    {
        data.push(pad ? 0x11 : 0xEC);
    }
    /** @type {number[][]} */
    const dataBlocks = [];
    let at = 0;
    for (const size of blocks)
    {
        dataBlocks.push(data.slice(at, at + size));
        at += size;
    }
    const ecBlocks = dataBlocks.map(block=>[...reedSolomon(block, ecCount)]);
    /** @type {number[]} */
    const out = [];
    const longest = Math.max(...blocks);
    for (let i = 0; i < longest; i++)
    {
        for (const block of dataBlocks)
        {
            if (i < block.length)
            {
                out.push(block[i]);
            }
        }
    }
    for (let i = 0; i < ecCount; i++)
    {
        for (const block of ecBlocks)
        {
            out.push(block[i]);
        }
    }
    return out;
}

/**
 * The penalty the standard gives a symbol; the lowest wins.
 *
 * @param {boolean[][]} grid
 */
function penalty(grid){
    const size = grid.length;
    let score = 0;
    /** @param {(i: number, j: number) => boolean} at */
    const lines = at=>{
        for (let i = 0; i < size; i++)
        {
            let run = 1;
            for (let j = 1; j <= size; j++)
            {
                if (j < size && at(i, j) === at(i, j - 1))
                {
                    run++;
                    continue;
                }
                if (run >= 5)
                {
                    score += 3 + run - 5;
                }
                run = 1;
            }
            // 1:1:3:1:1 dark-light-dark-light-dark with four light on a side.
            for (let j = 0; j + 11 <= size; j++)
            {
                const window = [];
                for (let k = 0; k < 11; k++)
                {
                    window.push(at(i, j + k) ? 1 : 0);
                }
                const text = window.join('');
                if (text === '10111010000' || text === '00001011101')
                {
                    score += 40;
                }
            }
        }
    };
    lines((y, x)=>grid[y][x]);
    lines((x, y)=>grid[y][x]);
    let dark = 0;
    for (let y = 0; y < size; y++)
    {
        for (let x = 0; x < size; x++)
        {
            dark += grid[y][x] ? 1 : 0;
            if (x + 1 < size && y + 1 < size && grid[y][x] === grid[y][x + 1]
                && grid[y][x] === grid[y + 1][x] && grid[y][x] === grid[y + 1][x + 1])
            {
                score += 3;
            }
        }
    }
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
}

/**
 * Encodes text as a QR code.
 *
 * @param {string} text
 * @returns {boolean[][]}  Rows of modules, true for dark, without the quiet zone.
 */
export function encodeQr(text){
    const bytes = new TextEncoder().encode(text);
    const version = VERSIONS_M.findIndex(([, blocks], index)=>index > 0
        && blocks.reduce((sum, n)=>sum + n, 0) * 8 >= 4 + (index < 10 ? 8 : 16) + bytes.length * 8);
    if (version < 0)
    {
        throw new RangeError(`qr: ${bytes.length} bytes are more than a version 10 code holds`);
    }
    const size = version * 4 + 17;
    const grid = Array.from({ length: size }, ()=>new Array(size).fill(false));
    const fixed = Array.from({ length: size }, ()=>new Array(size).fill(false));
    /** @param {number} x @param {number} y @param {boolean} dark */
    const set = (x, y, dark)=>{
        grid[y][x] = dark;
        fixed[y][x] = true;
    };

    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    {
        for (let dy = -4; dy <= 4; dy++)
        {
            for (let dx = -4; dx <= 4; dx++)
            {
                const x = cx + dx;
                const y = cy + dy;
                if (x >= 0 && y >= 0 && x < size && y < size)
                {
                    const ring = Math.max(Math.abs(dx), Math.abs(dy));
                    set(x, y, ring !== 2 && ring !== 4);
                }
            }
        }
    }
    for (let i = 8; i < size - 8; i++)
    {
        set(i, 6, i % 2 === 0);
        set(6, i, i % 2 === 0);
    }
    const centres = ALIGNMENT[version];
    for (const cy of centres)
    {
        for (const cx of centres)
        {
            // Those that would sit on a finder pattern are left out; those
            // on a timing pattern are drawn over it.
            const last = centres[centres.length - 1];
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6))
            {
                continue;
            }
            for (let dy = -2; dy <= 2; dy++)
            {
                for (let dx = -2; dx <= 2; dx++)
                {
                    set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }
    const formatCells = formatPositions(size);
    for (const [x, y] of formatCells)
    {
        set(x, y, false);
    }
    // Always dark, beside the lower copy of the format bits.
    set(8, size - 8, true);
    if (version >= 7)
    {
        const bits = versionBits(version);
        for (let i = 0; i < 18; i++)
        {
            const dark = ((bits >>> i) & 1) === 1;
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, dark);
            set(b, a, dark);
        }
    }

    // The codewords, two columns at a time from the right, up then down,
    // stepping over the vertical timing pattern.
    const words = codewords(bytes, version);
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2)
    {
        if (right === 6)
        {
            right = 5;
        }
        const upward = ((size - 1 - right) >> 1) % 2 === 0;
        for (let step = 0; step < size; step++)
        {
            const y = upward ? size - 1 - step : step;
            for (const x of [right, right - 1])
            {
                if (fixed[y][x])
                {
                    continue;
                }
                // Past the last codeword come the remainder bits, all light.
                if (index < words.length * 8)
                {
                    grid[y][x] = ((words[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
                }
                index++;
            }
        }
    }

    let best = grid;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++)
    {
        const candidate = grid.map((row, y)=>row.map((dark, x)=>
            (fixed[y][x] ? dark : dark !== MASKS[mask](x, y))));
        const bits = formatBits(mask);
        for (const [x, y, bit] of formatCells)
        {
            candidate[y][x] = ((bits >>> bit) & 1) === 1;
        }
        const score = penalty(candidate);
        if (score < bestScore)
        {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

/**
 * A QR code as SVG, with the four-module quiet zone the standard asks for.
 *
 * @param {boolean[][]} modules
 * @param {number} [scale]  Pixels a module.
 */
export function qrToSvg(modules, scale = 8){
    const size = modules.length + 8;
    let path = '';
    modules.forEach((row, y)=>row.forEach((dark, x)=>{
        if (dark)
        {
            path += `M${x + 4} ${y + 4}h1v1h-1z`;
        }
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * scale}" height="${size * scale}"`
        + ` viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
