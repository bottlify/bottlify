/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hot functions of one image in a cork block profile, named from the image's PDB: its
 * public symbols, placed through the PDB's OMAP where the image was reordered after linking
 * (Windows' and .NET's own DLLs are). The PDB of a Microsoft image is on Microsoft's public
 * symbol server, under the image's CodeView name, GUID and age.
 *
 *   node tools/pdb-hot.mjs <blocks.json> <image.dll> <image.pdb> <base-hex> [top=40]
 *   node tools/pdb-hot.mjs find=<text> <image.dll> <image.pdb> <base-hex>
 *
 * The weight is block executions, not instructions: a share of where control went. `find=`
 * prints the symbols whose name holds the text at their address in the shipped image, for a
 * `debug.hook`.
 */

import { readFileSync } from 'node:fs';

/** The public symbol record (S_PUB32). */
const S_PUB32 = 0x110e;

/**
 * The streams of an MSF 7.00 file (a PDB).
 *
 * @param {Buffer} pdb
 * @returns {Buffer[]}
 */
function streamsOf(pdb){
    const blockSize = pdb.readUInt32LE(32);
    const directoryBytes = pdb.readUInt32LE(44);
    const directoryMap = pdb.readUInt32LE(52);
    /** @param {number} bytes */
    const blocks = bytes=>Math.ceil(bytes / blockSize);
    /** @param {number[]} list @param {number} size */
    const gather = (list, size)=>Buffer.concat(list.map(block=>
        pdb.subarray(block * blockSize, (block + 1) * blockSize))).subarray(0, size);
    const directory = gather(Array.from({ length: blocks(directoryBytes) },
        (_, at)=>pdb.readUInt32LE(directoryMap * blockSize + 4 * at)), directoryBytes);
    const count = directory.readUInt32LE(0);
    const sizes = Array.from({ length: count }, (_, at)=>directory.readInt32LE(4 + 4 * at));
    let at = 4 + 4 * count;
    return sizes.map(size=>{
        const list = [];
        for (let block = 0; block < blocks(Math.max(size, 0)); block++, at += 4)
        {
            list.push(directory.readUInt32LE(at));
        }
        return size > 0 ? gather(list, size) : Buffer.alloc(0);
    });
}

/**
 * An OMAP lookup: the address an RVA maps to, or null where it maps to none.
 *
 * @param {Buffer | null} omap
 * @returns {(rva: number) => number | null}
 */
function omapLookup(omap){
    return rva=>{
        if (!omap)
        {
            return rva;
        }
        let low = 0;
        let high = omap.length / 8 - 1;
        let best = -1;
        while (low <= high)
        {
            const middle = (low + high) >> 1;
            if (omap.readUInt32LE(8 * middle) <= rva)
            {
                best = middle;
                low = middle + 1;
            }
            else
            {
                high = middle - 1;
            }
        }
        const to = best < 0 ? 0 : omap.readUInt32LE(8 * best + 4);
        return to === 0 ? null : to + rva - omap.readUInt32LE(8 * best);
    };
}

const [first, dllFile, pdbFile, baseHex, top = '40'] = process.argv.slice(2);
if (!first || !dllFile || !pdbFile || !baseHex)
{
    console.error('usage: node tools/pdb-hot.mjs <blocks.json | find=text> <image.dll> '
        + '<image.pdb> <base-hex> [top]');
    process.exit(2);
}
const base = parseInt(baseHex, 16);
const streams = streamsOf(readFileSync(pdbFile));
const dbi = streams[3];
const symbolRecords = streams[dbi.readUInt16LE(20)];
// The optional debug header follows the DBI's substreams: module info, section contributions,
// the section map, file info, the type server map and the EC substream.
const debugHeader = [24, 28, 32, 36, 40, 52].reduce((sum, at)=>sum + dbi.readInt32LE(at), 64);
/** @param {number} slot */
const debugStream = slot=>{
    const index = dbi.readUInt16LE(debugHeader + 2 * slot);
    return index === 0xffff ? null : streams[index];
};
// The section headers the symbols were linked against (the original ones of a reordered image).
const sections = /** @type {Buffer} */ (debugStream(10) ?? debugStream(5));
const sectionRva = [];
for (let at = 0; at + 40 <= sections.length; at += 40)
{
    sectionRva.push(sections.readUInt32LE(at + 12));
}
const toSource = omapLookup(debugStream(3));
const fromSource = omapLookup(debugStream(4));

/** @type {[number, string][]} */
const symbols = [];
for (let at = 0; at + 4 <= symbolRecords.length;)
{
    const length = symbolRecords.readUInt16LE(at);
    if (symbolRecords.readUInt16LE(at + 2) === S_PUB32)
    {
        const offset = symbolRecords.readUInt32LE(at + 8);
        const segment = symbolRecords.readUInt16LE(at + 12);
        const end = symbolRecords.indexOf(0, at + 14);
        if (segment >= 1 && segment <= sectionRva.length)
        {
            symbols.push([sectionRva[segment - 1] + offset,
                symbolRecords.toString('latin1', at + 14, end)]);
        }
    }
    at += 2 + length;
}
symbols.sort((a, b)=>a[0] - b[0]);

if (first.startsWith('find='))
{
    for (const [rva, name] of symbols)
    {
        if (name.includes(first.slice(5)))
        {
            const shipped = fromSource(rva);
            console.log(shipped === null ? `(dropped) ${name}`
                : `0x${(base + shipped).toString(16)} ${name}`);
        }
    }
    process.exit(0);
}

/** The public symbol at or before a source RVA. @param {number} rva */
const named = rva=>{
    let low = 0;
    let high = symbols.length - 1;
    let best = -1;
    while (low <= high)
    {
        const middle = (low + high) >> 1;
        if (symbols[middle][0] <= rva)
        {
            best = middle;
            low = middle + 1;
        }
        else
        {
            high = middle - 1;
        }
    }
    return best < 0 ? '?' : symbols[best][1];
};
const dll = readFileSync(dllFile);
const imageSize = dll.readUInt32LE(dll.readUInt32LE(0x3c) + 80);
const { blocks } = JSON.parse(readFileSync(first, 'utf8'));
/** @type {Map<string, number>} */
const byName = new Map();
let all = 0;
let inImage = 0;
for (const [eip, count] of blocks)
{
    all += count;
    if (eip < base || eip >= base + imageSize)
    {
        continue;
    }
    inImage += count;
    const source = toSource(eip - base);
    const name = source === null ? '(no source)' : named(source);
    byName.set(name, (byName.get(name) ?? 0) + count);
}
console.log(`${symbols.length} public symbols; the image ${(100 * inImage / all).toFixed(1)}% `
    + `of ${all} block executions`);
for (const [name, count] of [...byName].sort((a, b)=>b[1] - a[1]).slice(0, Number(top)))
{
    console.log(`${(100 * count / all).toFixed(2).padStart(6)}%  ${name}`);
}
