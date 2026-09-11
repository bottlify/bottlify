/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds sequential JPEG streams from coefficient blocks, for the tests of the
 * decoder and of the library that fronts it: no fixture from anywhere, and an
 * encoder small enough to read.
 */

const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
    41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
    30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

/**
 * A Huffman table with every symbol at the same code length: canonical, so the
 * symbol's index is its code. One length longer than the symbols need, so the
 * all-ones code is never used, as the standard advises.
 *
 * @param {number[]} symbols
 */
function flatTable(symbols){
    let length = 1;
    while ((1 << length) - 1 < symbols.length)
    {
        length++;
    }
    const counts = new Array(16).fill(0);
    counts[length - 1] = symbols.length;
    return { length, symbols, counts, codeOf: (/** @type {number} */ s)=>symbols.indexOf(s) };
}

/** Writes bits MSB first with the 0xFF stuffing the entropy segment requires. */
class BitWriter {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
        this.acc = 0;
        this.n = 0;
    }

    /** @param {number} value @param {number} bits */
    write(value, bits){
        for (let i = bits - 1; i >= 0; i--)
        {
            this.acc = (this.acc << 1) | ((value >> i) & 1);
            this.n++;
            if (this.n === 8)
            {
                this.bytes.push(this.acc);
                if (this.acc === 0xff)
                {
                    this.bytes.push(0);
                }
                this.acc = 0;
                this.n = 0;
            }
        }
    }

    /** Pads with ones to the byte, as an encoder does before a marker. */
    flush(){
        while (this.n !== 0)
        {
            this.write(1, 1);
        }
    }
}

/** @param {number} value */
const category = value=>{
    let v = Math.abs(value);
    let s = 0;
    while (v > 0)
    {
        s++;
        v >>= 1;
    }
    return s;
};
/** @param {number} value @param {number} s */
const extraBits = (value, s)=>(value >= 0 ? value : value + (1 << s) - 1);

/**
 * A sequential JPEG from quantised coefficient blocks.
 *
 * @param {Object} spec
 * @param {number} spec.width @param {number} spec.height
 * @param {{ h: number, v: number, blocks: number[][] }[]} spec.components
 *        Each component's blocks in coding order (raster within the MCU), 64
 *        coefficients each in natural order, already quantised.
 * @param {number[]} spec.quant  64 entries, natural order, shared by every component.
 * @param {number} [spec.restart]  A restart interval in MCUs, with RSTn markers.
 * @param {number} [spec.sof]  0xc0 by default; 0xc2 makes a progressive frame.
 */
export function encode({ width, height, components, quant, restart = 0, sof = 0xc0 }){
    /** @type {number[]} */
    const out = [0xff, 0xd8];
    const segment = (/** @type {number} */ marker, /** @type {number[]} */ body)=>{
        out.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
    };
    segment(0xdb, [0, ...ZIGZAG.map(i=>quant[i])]);
    segment(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components.length,
        ...components.flatMap((c, i)=>[i + 1, (c.h << 4) | c.v, 0])]);

    // Tables covering every symbol the blocks need.
    const dcSymbols = new Set([0]);
    const acSymbols = new Set([0x00, 0xf0]);
    for (const c of components)
    {
        let pred = 0;
        for (const block of c.blocks)
        {
            dcSymbols.add(category(block[0] - pred));
            pred = block[0];
            for (let k = 1; k < 64; k++)
            {
                const value = block[ZIGZAG[k]];
                if (value !== 0)
                {
                    acSymbols.add(category(value)); // the run is added below
                }
            }
        }
    }
    // Runs: every (run, size) pair actually used, found by a dry run of the coder.
    /** @param {number[]} block @param {(rs: number, value: number, s: number) => void} emit */
    const codeAc = (block, emit)=>{
        let run = 0;
        for (let k = 1; k < 64; k++)
        {
            const value = block[ZIGZAG[k]];
            if (value === 0)
            {
                run++;
                continue;
            }
            while (run > 15)
            {
                emit(0xf0, 0, 0);
                run -= 16;
            }
            const s = category(value);
            emit((run << 4) | s, value, s);
            run = 0;
        }
        if (run > 0)
        {
            emit(0x00, 0, 0);
        }
    };
    for (const c of components)
    {
        for (const block of c.blocks)
        {
            codeAc(block, rs=>acSymbols.add(rs));
        }
    }
    const dc = flatTable([...dcSymbols].sort((a, b)=>a - b));
    const ac = flatTable([...acSymbols].sort((a, b)=>a - b));
    segment(0xc4, [0x00, ...dc.counts, ...dc.symbols, 0x10, ...ac.counts, ...ac.symbols]);
    if (restart)
    {
        segment(0xdd, [restart >> 8, restart & 0xff]);
    }
    segment(0xda, [components.length, ...components.flatMap((c, i)=>[i + 1, 0x00]), 0, 63, 0]);

    const writer = new BitWriter();
    const hmax = Math.max(...components.map(c=>c.h));
    const vmax = Math.max(...components.map(c=>c.v));
    const mcusPerLine = Math.ceil(width / (8 * hmax));
    const mcusPerColumn = Math.ceil(height / (8 * vmax));
    const preds = components.map(()=>0);
    const next = components.map(()=>0);
    let rst = 0;
    for (let mcu = 0; mcu < mcusPerLine * mcusPerColumn; mcu++)
    {
        if (restart && mcu > 0 && mcu % restart === 0)
        {
            writer.flush();
            writer.bytes.push(0xff, 0xd0 + (rst & 7));
            rst++;
            preds.fill(0);
        }
        components.forEach((c, i)=>{
            for (let b = 0; b < c.h * c.v; b++)
            {
                const block = c.blocks[next[i]++];
                const diff = block[0] - preds[i];
                preds[i] = block[0];
                const s = category(diff);
                writer.write(dc.codeOf(s), dc.length);
                writer.write(extraBits(diff, s), s);
                codeAc(block, (rs, value, size)=>{
                    writer.write(ac.codeOf(rs), ac.length);
                    if (size > 0)
                    {
                        writer.write(extraBits(value, size), size);
                    }
                });
            }
        });
    }
    writer.flush();
    out.push(...writer.bytes, 0xff, 0xd9);
    return Uint8Array.from(out);
}

/**
 * The picture a block of dequantised coefficients defines, by the definition
 * of the inverse DCT and nothing cleverer.
 *
 * @param {number[]} block  Quantised, natural order.
 * @param {number[]} quant
 */
export function reference(block, quant){
    const out = new Array(64);
    const c = (/** @type {number} */ u)=>(u === 0 ? Math.SQRT1_2 : 1);
    for (let y = 0; y < 8; y++)
    {
        for (let x = 0; x < 8; x++)
        {
            let sum = 0;
            for (let v = 0; v < 8; v++)
            {
                for (let u = 0; u < 8; u++)
                {
                    sum += c(u) * c(v) * block[v * 8 + u] * quant[v * 8 + u]
                        * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
                }
            }
            out[y * 8 + x] = Math.min(255, Math.max(0, Math.round(sum / 4 + 128)));
        }
    }
    return out;
}

export const FLAT = new Array(64).fill(1);
/** @param {number} dc @param {[number, number][]} [ac] index/value pairs in natural order */
export const block = (dc, ac = [])=>{
    const b = new Array(64).fill(0);
    b[0] = dc;
    for (const [i, v] of ac)
    {
        b[i] = v;
    }
    return b;
};

