#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The signatures of a C runtime's functions, as cork's dictionary of them
 * keeps them (`modules/cork/src/helpers.js`): taken from a runtime library's
 * exports, where each function has its name, and matched against the copies a
 * program links into its own image, where it has none.
 *
 *   node tools/crt-dictionary.mjs <library.dll> <name>[=<entry name>] ...
 *       [--find <image>...]
 *
 * A function is the code reachable from its entry -- branches followed, a
 * switch's table of targets read -- inside its own extent (the exception
 * table's entry in a 64-bit image; up to the next export in a 32-bit one):
 * its spans are those instructions' bytes, the tables between them left out.
 * What differs between two copies of one object linked at two places is
 * masked: an absolute address the image relocates (its base relocations), a
 * RIP-relative displacement, a call or jump out of the extent, and a
 * displacement that is an offset into the image (a 64-bit switch table's).
 * The fingerprint is `helpers.js`'s over the spans with the masked bytes
 * read as zeroes.
 *
 * `--find` looks each signature up in other images by its quick key, then
 * whole, and prints where it is found: whether a program's own copy is the
 * library's.
 *
 *   node tools/crt-dictionary.mjs --verify <library.dll> <name>=<operation>[@<entry name>] ...
 *
 * runs a 32-bit library's own function on seeded arguments in cork's test
 * machine, the library relocated into it, through its body and as the
 * operation (`emit/crt.js`), and says where the two answer apart: what the
 * dictionary may hold its signature for.
 */

import { readFile } from 'node:fs/promises';
import { decode, MODE_64 } from '../modules/cork/src/decode/decoder.js';
import { applyRelocations, parsePe, readExports }
    from '../modules/core/src/layers/loader/internal/pe.js';
import { maskedFingerprint, QUICK_BYTES } from '../modules/cork/src/helpers.js';
import { CRT_BODIES, CRT_DICTIONARY } from '../modules/cork/src/crt-dictionary.js';

/** The operations on a double argument, returned in ST0. */
const FLOATS = ['sqrt', 'floor', 'ceil'];

/**
 * What the dictionary's entry of these bytes and this operation adds to a signature:
 * the global it reads (`word`), what it puts first (`lead`), the code its jump
 * leads to (`via`), and whether it is formed only at double precision (`precise`).
 *
 * @param {string} hash @param {string} operation
 */
const knownOf = (hash, operation)=>{
    const known = CRT_DICTIONARY.find(entry=>entry.hash === hash && entry.does === operation)
        ?? CRT_DICTIONARY.find(entry=>entry.hash === hash);
    return Object.fromEntries(Object.entries({ word: known?.word, lead: known?.lead,
        via: known?.via, precise: known?.precise }).filter(([, value])=>value !== undefined));
};

/** The x87 transcendentals (`_CIsin` and kin): ST0 (ST1) in, ST0 out, compared within ulps. */
const CI = ['cisin', 'cicos', 'citan', 'ciatan', 'ciasin', 'ciacos', 'cilog', 'cilog10', 'ciexp',
    'cipow'];

/** The comparisons and searches, whose cases are made by `scanCase`. */
const SCANS = ['memcmp', 'strcmp', 'memchr', 'strchr'];

/**
 * A comparison's or search's arguments, the data made for it: two spans equal
 * up to a seeded first difference (or none), a string's zero after `length`
 * bytes, the byte sought in it, its zero or neither.
 *
 * @param {string} operation @param {Uint8Array} data @param {number} at  data's address
 * @param {(n: number) => number} int @param {number} length @param {number} dst
 * @param {number} src
 * @returns {number[]}
 */
function scanCase(operation, data, at, int, length, dst, src){
    if (operation === 'strcmp' || operation === 'strchr')
    {
        data.forEach((v, i)=>{
            data[i] = v === 0 ? 1 : v;
        });
    }
    if (operation === 'memchr' || operation === 'strchr')
    {
        const sought = [data[src - at + int(length + 1)], 0, int(256), data[src - at]][int(4)];
        if (operation === 'strchr')
        {
            data[src - at + length] = 0;
        }
        return operation === 'memchr' ? [src, sought | int(2) * 0x1200, length]
            : [src, sought | int(2) * 0x3400];
    }
    // Two spans equal to a first difference at `k`, or wholly.
    const apart = Math.abs(dst - src) >= length;
    const k = int(length + 1);
    if (apart)
    {
        data.copyWithin(dst - at, src - at, src - at + k);
        if (k < length && int(2) === 0)
        {
            data[dst - at + k] = data[src - at + k] ^ (1 << int(8));
        }
    }
    if (operation === 'strcmp')
    {
        data[src - at + length] = 0;
        if (apart && k === length)
        {
            data[dst - at + length] = int(2) === 0 ? 0 : 1 + int(255);
        }
        return [dst, src];
    }
    return [dst, src, length];
}

const DIR_EXCEPTION = 3;
const DIR_BASERELOC = 5;
/** The farthest a 32-bit function's extent reaches when no export follows it. */
const EXTENT_LIMIT = 0x2000;

/**
 * The image as it is mapped: every section at its address.
 *
 * @param {Uint8Array} bytes
 */
export function mapImage(bytes){
    const image = parsePe(bytes, { wide: true });
    const mapped = new Uint8Array(image.sizeOfImage);
    mapped.set(bytes.subarray(0, Math.min(image.sizeOfHeaders, bytes.length)));
    for (const section of image.sections)
    {
        const raw = bytes.subarray(section.rawOffset,
            section.rawOffset + Math.min(section.rawSize, section.virtualSize || section.rawSize));
        mapped.set(raw, section.virtualAddress);
    }
    return { image, mapped };
}

/**
 * The RVAs of every byte an absolute address the image relocates covers.
 *
 * @param {Uint8Array} mapped @param {import('../modules/core/src/layers/loader/internal/pe.js').PeImage} image
 */
function relocatedBytes(mapped, image){
    const view = new DataView(mapped.buffer);
    const out = new Set();
    const { address, size } = image.directories[DIR_BASERELOC] ?? { address: 0, size: 0 };
    for (let at = address; at < address + size;)
    {
        const page = view.getUint32(at, true);
        const blockSize = view.getUint32(at + 4, true);
        if (blockSize < 8)
        {
            break;
        }
        for (let entry = at + 8; entry < at + blockSize; entry += 2)
        {
            const word = view.getUint16(entry, true);
            const kind = word >>> 12;
            const width = kind === 3 ? 4 : kind === 10 ? 8 : 0;
            for (let k = 0; k < width; k++)
            {
                out.add(page + (word & 0xfff) + k);
            }
        }
        at += blockSize;
    }
    return out;
}

/**
 * A 64-bit function's extent: its entry in the exception table, joined with
 * the entries that continue it (an unwind chain's own ranges are the function's).
 *
 * @param {Uint8Array} mapped @param {any} image @param {number} entry
 * @returns {[number, number] | null}
 */
function extentFromTable(mapped, image, entry){
    const view = new DataView(mapped.buffer);
    const { address, size } = image.directories[DIR_EXCEPTION] ?? { address: 0, size: 0 };
    for (let at = address; at + 12 <= address + size; at += 12)
    {
        const begin = view.getUint32(at, true);
        const end = view.getUint32(at + 4, true);
        if (begin <= entry && entry < end)
        {
            return [begin, end];
        }
    }
    return null;
}

/**
 * The positions in an instruction's bytes of a 4-byte little-endian value.
 *
 * @param {Uint8Array} mapped @param {number} start @param {number} length @param {number} value
 */
function positionsOf(mapped, start, length, value){
    const out = [];
    for (let at = start; at + 4 <= start + length; at++)
    {
        if (((mapped[at] | mapped[at + 1] << 8 | mapped[at + 2] << 16 | mapped[at + 3] << 24)
            >>> 0) === (value >>> 0))
        {
            out.push(at);
        }
    }
    return out;
}

/**
 * The signature of the function at `entry` (an RVA).
 *
 * @param {Uint8Array} mapped @param {any} image @param {number} entry
 * @param {[number, number]} extent  [start, end) its code may lie in
 * @param {Set<number>} relocated
 */
export function signatureOf(mapped, image, entry, extent, relocated){
    const wide = image.bits === 64;
    const mode = wide ? MODE_64 : undefined;
    const read = (/** @type {number} */ at)=>mapped[at] ?? 0;
    const inside = (/** @type {number} */ at)=>at >= extent[0] && at < extent[1];
    /** @type {Map<number, number>} RVA -> length */
    const code = new Map();
    const masked = new Set();
    /** @type {number[]} */
    const refused = [];
    const pending = [entry];
    const view = new DataView(mapped.buffer);
    /** @param {number} at @param {number} value */
    const maskValue = (at, length, value)=>{
        for (const p of positionsOf(mapped, at, length, value))
        {
            for (let k = 0; k < 4; k++)
            {
                masked.add(p + k);
            }
        }
    };
    while (pending.length > 0)
    {
        let at = /** @type {number} */ (pending.pop());
        while (inside(at) && !code.has(at))
        {
            const ins = decode(read, at, mode);
            if ('refused' in ins)
            {
                // What cork's decoder does not read (long mode's VEX forms):
                // the path ends there, and its bytes are not in the signature.
                refused.push(at);
                break;
            }
            code.set(at, ins.length);
            for (let k = 0; k < ins.length; k++)
            {
                if (relocated.has(at + k))
                {
                    masked.add(at + k);
                }
            }
            const next = at + ins.length;
            for (const operand of ins.operands)
            {
                if (operand.kind === 'mem' && operand.rip)
                {
                    maskValue(at, ins.length, (/** @type {number} */ (operand.disp) - next) >>> 0);
                }
                else if (wide && operand.kind === 'mem' && (operand.base ?? -1) >= 0
                    && (operand.disp ?? 0) >= 0x1000 && (operand.disp ?? 0) < image.sizeOfImage)
                {
                    // An offset into the image from its base in a register:
                    // a switch's table of offsets.
                    maskValue(at, ins.length, /** @type {number} */ (operand.disp));
                    const table = /** @type {number} */ (operand.disp);
                    if (operand.scale === 4)
                    {
                        for (let i = 0; table + 4 * i + 4 <= mapped.length; i++)
                        {
                            const target = view.getUint32(table + 4 * i, true);
                            if (!inside(target))
                            {
                                break;
                            }
                            pending.push(target);
                        }
                    }
                }
            }
            const { op } = ins;
            const target = ins.operands[0]?.kind === 'rel'
                ? /** @type {number} */ (ins.operands[0].target) : -1;
            if (target >= 0 && !inside(target))
            {
                // Out of the function: where it lands is where it was linked.
                for (let k = ins.length - 4; k < ins.length; k++)
                {
                    masked.add(at + k);
                }
            }
            else if (target >= 0 && op !== 'call')
            {
                pending.push(target);
            }
            if (!wide && op === 'jmp' && ins.operands[0].kind === 'mem'
                && ins.operands[0].base === -1 && (ins.operands[0].scale ?? 0) === 4)
            {
                // A 32-bit switch: a table of absolute addresses.
                const table = /** @type {number} */ (ins.operands[0].disp) - image.imageBase;
                for (let i = 0; table + 4 * i + 4 <= mapped.length; i++)
                {
                    const to = view.getUint32(table + 4 * i, true) - image.imageBase;
                    if (!inside(to))
                    {
                        break;
                    }
                    pending.push(to);
                }
            }
            if (op === 'ret' || op === 'jmp' || op === 'int3' || op === 'hlt'
                || (op === 'int' && ins.operands[0]?.value === 3))
            {
                break;
            }
            at = next;
        }
    }
    // Spans, offsets from the entry; may lie before it.
    const starts = [...code.keys()].sort((a, b)=>a - b);
    /** @type {[number, number][]} */
    const spans = [];
    for (const start of starts)
    {
        const end = start + /** @type {number} */ (code.get(start));
        const last = spans[spans.length - 1];
        if (last !== undefined && last[0] + last[1] === start - entry)
        {
            last[1] += end - start;
        }
        else
        {
            spans.push([start - entry, end - start]);
        }
    }
    const masks = [...masked].map(at=>at - entry).sort((a, b)=>a - b);
    const readAt = (/** @type {number} */ offset)=>mapped[entry + offset] ?? 0;
    return {
        bits: image.bits,
        spans, masks, refused: refused.map(at=>at - entry),
        quick: maskedFingerprint(readAt, 0, [[spans.find(([o])=>o === 0)?.[0] ?? 0,
            Math.min(QUICK_BYTES, spans.find(([o])=>o === 0)?.[1] ?? 0)]], masks),
        hash: maskedFingerprint(readAt, 0, spans, masks),
    };
}

/**
 * The extent of the function at `entry`: its exception table entry, or up to
 * the next export.
 *
 * @param {Uint8Array} mapped @param {any} image @param {number} entry
 * @param {number[]} exported  every export's RVA, sorted
 * @returns {[number, number]}
 */
export function extentOf(mapped, image, entry, exported){
    const table = image.bits === 64 ? extentFromTable(mapped, image, entry) : null;
    if (table !== null)
    {
        return table;
    }
    const after = exported.find(rva=>rva > entry);
    return [entry, Math.min(after ?? Infinity, entry + EXTENT_LIMIT)];
}

/**
 * A function of the library by its export's name, or by its RVA (`0x...`) for
 * one the library has but does not export (the compiler's helpers in a runtime).
 *
 * @param {any[]} exports @param {string} name
 * @returns {{ rva: number } | undefined}
 */
function findFunction(exports, name){
    return /^0x[0-9a-f]+$/i.test(name) ? { rva: Number.parseInt(name, 16) }
        : exports.find(e=>e.name === name);
}

/** A seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * The library's functions against the operations, on seeded arguments.
 *
 * @param {string} library @param {string[]} specs  `name=operation[@export]`
 */
async function verify(library, specs){
    const { createTestMachine } = await import('../modules/cork/src/testing/machine.js');
    const bytes = new Uint8Array(await readFile(library));
    const { image, mapped } = mapImage(bytes);
    if (image.bits !== 32)
    {
        throw new Error('--verify runs 32-bit libraries');
    }
    const BASE = 0x400000;
    // The signatures from the image as linked; the machine runs it relocated.
    const linked = mapped.slice();
    applyRelocations(mapped, image, BASE - image.imageBase);
    const { exports } = readExports(bytes, image);
    const exported = [...new Set(exports.filter(e=>e.forwards === null).map(e=>e.rva))]
        .sort((a, b)=>a - b);
    const relocated = relocatedBytes(linked, image);
    const PROGRAM = 0x8000;
    const OUT = 0xa000;
    const DATA = 0x100000;
    const DATA_BYTES = 0x8000;
    const STACK = 0x80000;
    const RAM = 16 << 20;
    const u32 = (/** @type {number} */ v)=>[v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];
    for (const spec of specs)
    {
        const [name, rest] = spec.split('=');
        const [operation, exportName = name] = rest.split('@');
        const found = findFunction(exports, exportName);
        if (found === undefined)
        {
            console.log(`${name}: not exported`);
            continue;
        }
        const signature = signatureOf(linked, image, found.rva,
            extentOf(linked, image, found.rva, exported), relocated);
        const entry = BASE + found.rva;
        // The globals the function tests (a processor's features, the runtime's
        // choice of a copy's way) set to CRT_FLAGS, when given: its other paths.
        const featureValue = process.env.CRT_FLAGS;
        if (featureValue !== undefined)
        {
            const view = new DataView(mapped.buffer);
            for (const [offset, length] of signature.spans)
            {
                for (let at = found.rva + offset; at < found.rva + offset + length;)
                {
                    const ins = decode(a=>linked[a] ?? 0, at);
                    if ('refused' in ins)
                    {
                        break;
                    }
                    // Only a global the code tests (`cmp`/`test` with a constant):
                    // a table of constants it reads is no feature to set.
                    const tested = (ins.op === 'cmp' || ins.op === 'test')
                        && ins.operands[1]?.kind === 'imm';
                    for (const operand of tested ? ins.operands : [])
                    {
                        const rva = (operand.disp ?? 0) - image.imageBase;
                        if (operand.kind === 'mem' && operand.base === -1 && operand.index === -1
                            && rva > 0 && rva + 4 <= mapped.length
                            && !image.sections.find(sec=>sec.executable
                                && rva >= sec.virtualAddress
                                && rva < sec.virtualAddress + sec.virtualSize))
                        {
                            view.setUint32(rva, Number(featureValue), true);
                        }
                    }
                    at += ins.length;
                }
            }
        }
        const extent = [Math.min(...signature.spans.map(([o])=>o)),
            Math.max(...signature.spans.map(([o, n])=>o + n))];
        const helper = { name, does: /** @type {any} */ (operation), bits: 32,
            spans: signature.spans, masks: signature.masks, quick: signature.quick,
            hash: signature.hash, length: extent[1] - extent[0],
            ...CRT_BODIES[operation] === undefined ? {} : { body: CRT_BODIES[operation] },
            ...knownOf(signature.hash, operation) };
        let apart = 0;
        let formed = 0;
        let ulps = 0;
        const cases = 400;
        for (let seed = 1; seed <= cases; seed++)
        {
            const next = random(seed * 104729 + name.length);
            const int = (/** @type {number} */ n)=>Math.floor(next() * n);
            const data = new Uint8Array(DATA_BYTES).map(()=>int(256));
            const length = [0, 1, 3, 15, 16, 17, 31, 64, 255, 256, 257, 1000, 4096, 0x5000][int(14)]
                + (int(2) ? int(8) : 0);
            const place = ()=>DATA + int(DATA_BYTES - length);
            const dst = place();
            const src = int(4) === 0 ? dst + int(64) - 32 : place();
            /** @type {number[]} */
            let args;
            if (operation === 'strlen')
            {
                data.forEach((v, i)=>{
                    data[i] = v === 0 ? 1 : v;
                });
                data[src - DATA + length] = 0;
                args = [src];
            }
            else if (FLOATS.includes(operation))
            {
                const values = [0, -0, 1, 2, 0.25, 1e300, 1e-310, Infinity, -1, NaN,
                    next() * 1e6, 2 ** 52 + int(1000), -2.5, -0.5, 0.5, (next() - 0.5) * 1e3,
                    -Infinity, 2 ** 53 - 0.5, -(2 ** 31) - 0.5, 1e-300 * (next() - 0.5)];
                const view = new DataView(new ArrayBuffer(8));
                view.setFloat64(0, values[int(values.length)], true);
                args = [view.getUint32(0, true), view.getUint32(4, true)];
            }
            else if (operation === 'memset')
            {
                args = [dst, int(2 ** 32) >>> 0, length];
            }
            else if (SCANS.includes(operation))
            {
                args = scanCase(operation, data, DATA, int, Math.min(length, DATA_BYTES / 2 - 1),
                    dst, Math.max(DATA, Math.min(src, DATA + DATA_BYTES - length - 1)));
            }
            else
            {
                args = [dst, Math.max(DATA, Math.min(src, DATA + DATA_BYTES - length)), length];
            }
            const program = [];
            const call = ()=>program.push(0xe8,
                ...u32((entry - (PROGRAM + program.length + 5)) >>> 0));
            // mov [OUT+k], reg for each register: eax, edx, ecx, ebx, esp.
            const stores = ()=>[[0x05, 0], [0x15, 4], [0x0d, 8], [0x1d, 12], [0x25, 16]]
                .forEach(([modrm, k])=>program.push(0x89, modrm, ...u32(OUT + k)));
            const quads = ['allmul', 'alldiv', 'aulldiv', 'allrem', 'aullrem', 'alldvrm',
                'aulldvrm'];
            if (quads.includes(operation))
            {
                const word = ()=>[0, 1, 0xffffffff, 0x80000000, int(2 ** 32) >>> 0,
                    int(16)][int(6)];
                for (let k = 0; k < 4; k++)
                {
                    program.push(0x68, ...u32(word()));
                }
                call();
                stores();
            }
            else if (operation.endsWith('shl') || operation.endsWith('shr'))
            {
                program.push(0xb8, ...u32(int(2 ** 32) >>> 0), 0xba, ...u32(int(2 ** 32) >>> 0),
                    0xb9, ...u32([int(256), int(32), 32 + int(32), 64, 63, 0][int(6)]));
                call();
                stores();
            }
            else if (operation === 'chkstk')
            {
                program.push(0xb8, ...u32([0, 4, 0x1000, 0x2345, 0x10000][int(5)]));
                call();
                stores();
            }
            else if (CI.includes(operation))
            {
                // ST0 (and for pow ST1, the base) from seeded doubles, the result to OUT.
                const pick = ()=>{
                    const kind = int(9);
                    return kind === 0 ? [0, -0, NaN, Infinity, -Infinity, 1, -1, 1e20][int(8)]
                        : kind === 1 ? (next() - 0.5) * 2.4
                            : kind === 2 ? (next() - 0.5) * 2000
                                : kind === 3 ? next() * 1e3
                                    // Any size, 2^-70 to 2^70.
                                    : kind === 4 ? (next() - 0.5) * 2 ** (int(141) - 70)
                                        : (next() - 0.5) * 20;
                };
                const view = new DataView(data.buffer);
                const two = operation === 'cipow';
                view.setFloat64(0, two ? Math.abs(pick()) * (int(6) === 0 ? -1 : 1) : pick(), true);
                view.setFloat64(8, pick(), true);
                args = two ? [view.getFloat64(0, true), view.getFloat64(8, true)]
                    : [view.getFloat64(0, true)];
                program.push(0xdd, 0x05, ...u32(DATA));
                if (two)
                {
                    program.push(0xdd, 0x05, ...u32(DATA + 8));
                }
                call();
                program.push(0xdd, 0x1d, ...u32(OUT));             // fstp qword [OUT]
                program.push(0x89, 0x25, ...u32(OUT + 8));          // mov [OUT+8], esp
            }
            else if (operation === 'ftol2sse')
            {
                // ST0 from a seeded double at DATA, the call, the registers, then the
                // x87 status word and MXCSR (the truncation's flags) at OUT+20 and +24.
                const values = [0, -0, 0.5, -0.5, 1.5, -1.5, 2147483647.9, 2147483648,
                    -2147483648.5, -2147483649, 4294967296.5, 1e300, -1e300, Infinity,
                    -Infinity, NaN, 1e-310, (next() - 0.5) * 2 ** int(40)];
                new DataView(data.buffer).setFloat64(0, values[int(values.length)], true);
                program.push(0xdd, 0x05, ...u32(DATA));
                call();
                stores();
                program.push(0xdf, 0xe0, 0xa3, ...u32(OUT + 20));  // fnstsw ax; to OUT+20
                program.push(0x0f, 0xae, 0x1d, ...u32(OUT + 24));  // stmxcsr [OUT+24]
            }
            else
            {
                for (const arg of [...args].reverse())
                {
                    program.push(0x68, ...u32(arg));
                }
                call();
                program.push(0x83, 0xc4, 4 * args.length);
                program.push(...FLOATS.includes(operation) ? [0xdd, 0x1d, ...u32(OUT)]
                    : [0xa3, ...u32(OUT)]);
            }
            program.push(0xf4);
            const run = (/** @type {any} */ helpers)=>{
                const m = createTestMachine({ ramSize: RAM });
                m.write(BASE, mapped);
                m.write(PROGRAM, program);
                m.write(DATA, data);
                ['ebx', 'ebp', 'esi', 'edi'].forEach((r, i)=>m.setReg(r, 0x11111111 * (i + 1)));
                m.setReg('esp', STACK);
                if (process.env.CRT_CONTROL !== undefined)
                {
                    // The x87's control word (CRT_CONTROL, 0x7f: single precision, as
                    // Direct3D 9 leaves it).
                    new DataView(m.memory.buffer).setUint16(m.layout.x87Control,
                        Number(process.env.CRT_CONTROL), true);
                }
                let exit = m.runProgram(PROGRAM, { helpers, budget: 1e8 });
                const left = exit.kind === -2;
                if (left)
                {
                    exit = m.runProgram(exit.eip, { helpers: false, budget: 1e8 });
                }
                // ecx is the helper's to spoil where it is no result (cdecl's and
                // the helpers' convention alike), and not compared there.
                const out = [...m.read(OUT, operation === 'ftol2sse' ? 28 : 20)];
                if (['allmul', 'alldiv', 'aulldiv', 'allrem', 'aullrem'].includes(operation))
                {
                    out.fill(0, 8, 12);
                }
                // A transcendental's result within ulps (`CI`): its bytes compared apart.
                const value = new DataView(Uint8Array.from(out).buffer).getFloat64(0, true);
                if (CI.includes(operation))
                {
                    out.fill(0, 0, 8);
                }
                return { left, value, seen: JSON.stringify({ kind: exit.kind, out,
                    data: [...m.read(DATA, DATA_BYTES)],
                    regs: ['ebx', 'ebp', 'esi', 'edi', 'esp'].map(r=>m.reg(r)) }) };
            };
            const body = run(false);
            const made = run([helper]);
            formed += made.left ? 0 : 1;
            if (CI.includes(operation))
            {
                ulps = Math.max(ulps, ulpsApart(body.value, made.value));
            }
            if (body.seen !== made.seen || ulpsApart(body.value, made.value) > ULPS)
            {
                apart++;
                if (apart <= 3)
                {
                    console.log(`  ${name} apart: ${JSON.stringify(args)}`);
                    if (process.env.CRT_SHOW !== undefined)
                    {
                        console.log(`   ${body.seen.slice(0, 160)}\n   ${made.seen.slice(0, 160)}`);
                    }
                }
            }
        }
        console.log(`${name} as ${operation}: ${cases} cases, ${formed} formed, ${apart} apart`
            + (CI.includes(operation) ? `, results at most ${ulps} ulps apart` : ''));
    }
}

/** The ulps a transcendental's result may lie from the function's (`CI`). */
const ULPS = 4;

/**
 * How many doubles lie between two results: 0 for the same, or both NaN.
 * @param {number} a @param {number} b
 */
function ulpsApart(a, b){
    if (Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b))
    {
        return 0;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.sign(a) !== Math.sign(b))
    {
        return Infinity;
    }
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, Math.abs(a));
    view.setFloat64(8, Math.abs(b));
    const [x, y] = [view.getBigUint64(0), view.getBigUint64(8)];
    return Number(x > y ? x - y : y - x);
}

/**
 * A 64-bit library's functions against the operations, on seeded arguments:
 * two long-mode machines of cork's tests, the dictionary's helpers formed in
 * one and not in the other, the library relocated into both.
 *
 * @param {Uint8Array} bytes @param {any} image @param {Uint8Array} mapped
 * @param {any[]} exports @param {string[]} specs
 */
async function verify64(bytes, image, mapped, exports, specs){
    const { machine, run, EXIT } = await import('../modules/cork/src/testing/long-machine.js');
    const { pageFlagsAt } = await import('../modules/cork/src/runtime/layout.js');
    const BASE = 0x1000000;
    const DATA = 0x2000000;
    const DATA_BYTES = 0x8000;
    const OUT = 0x2100000;
    const STACK = 0x3000000;
    const PROGRAM = 0x20000000;
    const linked = mapped.slice();
    applyRelocations(mapped, image, BASE - image.imageBase);
    const exported = [...new Set(exports.filter(e=>e.forwards === null).map(e=>e.rva))]
        .sort((a, b)=>a - b);
    const relocated = relocatedBytes(linked, image);
    const made = (/** @type {boolean} */ helpers)=>{
        const m = machine({ config: { helpers } });
        const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), 1 << 20);
        for (const [at, size] of [[BASE, mapped.length], [DATA, DATA_BYTES], [OUT, 4096],
            [STACK - 0x10000, 0x10000], [PROGRAM, 4096]])
        {
            flags.fill(0, at >>> 12, (at + size + 4095) >>> 12);
        }
        new Uint8Array(m.memory.buffer).set(mapped, m.layout.ramBase + BASE);
        return m;
    };
    const machines = [made(false), made(true)];
    const q = (/** @type {number} */ v)=>{
        const out = [];
        let value = BigInt(v);
        for (let i = 0; i < 8; i++, value >>= 8n)
        {
            out.push(Number(value & 0xffn));
        }
        return out;
    };
    for (const spec of specs)
    {
        const [name, rest] = spec.split('=');
        const [operation, exportName = name] = rest.split('@');
        const found = findFunction(exports, exportName);
        if (found === undefined)
        {
            console.log(`${name}: not exported`);
            continue;
        }
        const signature = signatureOf(linked, image, found.rva,
            extentOf(linked, image, found.rva, exported), relocated);
        if (process.env.CRT_FLAGS !== undefined)
        {
            for (const m of machines)
            {
                const view = new DataView(m.memory.buffer);
                for (const [offset, length] of signature.spans)
                {
                    for (let at = found.rva + offset; at < found.rva + offset + length;)
                    {
                        const ins = decode(a=>linked[a] ?? 0, at, MODE_64);
                        if ('refused' in ins)
                        {
                            break;
                        }
                        const tested = (ins.op === 'cmp' || ins.op === 'test')
                            && ins.operands[1]?.kind === 'imm';
                        for (const operand of tested ? ins.operands : [])
                        {
                            if (operand.kind === 'mem' && operand.rip)
                            {
                                const rva = /** @type {number} */ (operand.disp);
                                if (!image.sections.find((/** @type {any} */ sec)=>sec.executable
                                    && rva >= sec.virtualAddress
                                    && rva < sec.virtualAddress + sec.virtualSize))
                                {
                                    view.setUint32(m.layout.ramBase + BASE + rva,
                                        Number(process.env.CRT_FLAGS), true);
                                }
                            }
                        }
                        at += ins.length;
                    }
                }
            }
        }
        const entry = BASE + found.rva;
        let apart = 0;
        const cases = 300;
        for (let seed = 1; seed <= cases; seed++)
        {
            const next = random(seed * 104729 + name.length);
            const int = (/** @type {number} */ n)=>Math.floor(next() * n);
            const data = new Uint8Array(DATA_BYTES).map(()=>int(256));
            const length = [0, 1, 3, 7, 8, 15, 16, 17, 31, 32, 33, 64, 255, 256, 257, 1000, 4096,
                0x5000][int(18)] + (int(2) ? int(8) : 0);
            const place = ()=>DATA + int(DATA_BYTES - length);
            const dst = place();
            const src = Math.max(DATA, Math.min(int(4) === 0 ? dst + int(64) - 32 : place(),
                DATA + DATA_BYTES - length));
            const args = operation === 'memset' ? [dst, int(2 ** 32), length]
                : operation === 'strlen' ? [src]
                    : SCANS.includes(operation) ? scanCase(operation, data, DATA, int,
                        Math.min(length, DATA_BYTES / 2 - 1),
                        dst, Math.max(DATA, Math.min(src, DATA + DATA_BYTES - length - 1)))
                        : [dst, src, length];
            // __chkstk: rax the bytes to have below rsp, the thread block in the data
            // with its StackLimit at the stack's open bottom or above it (a stack
            // to grow, its probe writing into the pages between).
            const chkstk = operation === 'chkstk64';
            const size = [0, 8, 0x1000, 0x2000, 0xf00, 0xff00, 0x10000, 0x20000, 2 ** 40][int(9)]
                + int(0x100);
            const limit = STACK - [0x10000, 0x8000, 0x1000][int(3)];
            if (operation === 'strlen')
            {
                data.forEach((v, i)=>{
                    data[i] = v === 0 ? 1 : v;
                });
                data[src - DATA + length] = 0;
            }
            const program = [
                ...chkstk ? [0x48, 0xb8, ...q(size)] : [0x48, 0xb9, ...q(args[0])],
                0x48, 0xba, ...q(args[1] ?? 0),
                0x49, 0xb8, ...q(args[2] ?? 0),
                0xe8, ...u32x((entry - (PROGRAM + 30 + 5)) >>> 0),
                0x48, 0x89, 0x04, 0x25, ...u32x(OUT),
                0xff, 0x25, 0, 0, 0, 0, ...q(EXIT),
            ];
            const seen = machines.map(m=>{
                const ram = new Uint8Array(m.memory.buffer);
                const view = new DataView(m.memory.buffer);
                m.runner.invalidate(PROGRAM, 4096);
                ram.set(program, m.layout.ramBase + PROGRAM);
                // Twice from the same state: the first run interprets the
                // program and makes it hot, the second runs it translated.
                let done = null;
                for (let pass = 0; pass < 2; pass++)
                {
                    ram.set(data, m.layout.ramBase + DATA);
                    if (chkstk)
                    {
                        view.setBigUint64(m.layout.ramBase + DATA + 0x10, BigInt(limit), true);
                    }
                    ram.fill(0, m.layout.ramBase + OUT, m.layout.ramBase + OUT + 8);
                    for (let r = 0; r < 16; r++)
                    {
                        view.setBigUint64(m.layout.regs + 8 * r,
                            BigInt(Math.imul(r + 1, 0x9e3779b1) >>> 0) << 16n, true);
                    }
                    view.setBigUint64(m.layout.regs + 8 * 4, BigInt(STACK - 0x100), true);
                    if (chkstk)
                    {
                        view.setBigUint64(m.layout.regs, BigInt(size), true);
                        view.setBigUint64(/** @type {number} */ (m.layout.gsBase), BigInt(DATA),
                            true);
                    }
                    view.setBigUint64(m.layout.eip, BigInt(PROGRAM), true);
                    view.setUint32(m.layout.eflags, 0x202, true);
                    view.setUint32(m.layout.mxcsr, 0x1f80, true);
                    new Uint8Array(m.memory.buffer)[m.layout.x87Empty] = 0xff;
                    view.setUint16(m.layout.x87Control, 0x37f, true);
                    m.state.syncIn();
                    m.state.halted = false;
                    m.state.retired = 0;
                    done = run(m, true, 1e9);
                }
                const regs = [...new BigUint64Array(m.memory.buffer, m.layout.regs, 16)];
                return JSON.stringify({ fault: done?.fault,
                    out: [...ram.subarray(m.layout.ramBase + OUT, m.layout.ramBase + OUT + 8)],
                    data: Buffer.from(ram.subarray(m.layout.ramBase + DATA,
                        m.layout.ramBase + DATA + DATA_BYTES)).toString('base64'),
                    saved: [3, 4, 5, 6, 7, ...chkstk ? [10, 11] : [], 12, 13, 14, 15]
                        .map(r=>regs[r].toString(16)),
                    xmm: Buffer.from(ram.subarray(m.layout.xmm + 96, m.layout.xmm + 256))
                        .toString('hex') });
            });
            if (seen[0] !== seen[1])
            {
                apart++;
                if (apart <= 3)
                {
                    console.log(`  ${name} apart: ${JSON.stringify(chkstk ? [size, limit] : args)}`
                        + `\n   ${seen[0].slice(0, 300)}\n   ${seen[1].slice(0, 300)}`);
                }
            }
        }
        console.log(`${name} as ${operation} (64-bit): ${cases} cases, ${apart} apart`);
    }
}

/** @param {number} v */
const u32x = v=>[v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];

async function main(){
    const args = process.argv.slice(2);
    if (args[0] === '--verify')
    {
        const bytes = new Uint8Array(await readFile(args[1]));
        const { image, mapped } = mapImage(bytes);
        if (image.bits === 64)
        {
            await verify64(bytes, image, mapped, readExports(bytes, image).exports,
                args.slice(2));
            return;
        }
        await verify(args[1], args.slice(2));
        return;
    }
    const findAt = args.indexOf('--find');
    const finds = findAt >= 0 ? args.splice(findAt).slice(1) : [];
    const [library, ...names] = args;
    const bytes = new Uint8Array(await readFile(library));
    const { image, mapped } = mapImage(bytes);
    const { exports } = readExports(bytes, image);
    const exported = [...new Set(exports.filter(e=>e.forwards === null).map(e=>e.rva))]
        .sort((a, b)=>a - b);
    const relocated = relocatedBytes(mapped, image);
    const images = await Promise.all(finds.map(async path=>({ path,
        ...mapImage(new Uint8Array(await readFile(path))) })));
    for (const spec of names)
    {
        const [name, exportName = name] = spec.split('=');
        const found = findFunction(exports, exportName);
        if (found === undefined)
        {
            console.log(`${name}: not exported`);
            continue;
        }
        const extent = extentOf(mapped, image, found.rva, exported);
        const signature = signatureOf(mapped, image, found.rva, extent, relocated);
        const length = signature.spans.reduce((sum, [, n])=>sum + n, 0);
        console.log(JSON.stringify({ name, ...signature, length }));
        for (const other of images)
        {
            const hits = [];
            const { spans, masks } = signature;
            const first = spans.find(([o])=>o === 0);
            for (let at = 0; at < other.mapped.length - 16; at++)
            {
                const readAt = (/** @type {number} */ offset)=>other.mapped[at + offset] ?? 0;
                if (first !== undefined && maskedFingerprint(readAt, 0,
                    [[0, Math.min(QUICK_BYTES, first[1])]], masks) === signature.quick
                    && maskedFingerprint(readAt, 0, spans, masks) === signature.hash)
                {
                    hits.push((at + other.image.imageBase).toString(16));
                }
            }
            const where = hits.length > 0 ? hits.join(' ') : 'none';
            console.log(`  ${other.path.split('/').pop()}: ${where}`);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`)
{
    await main();
}
