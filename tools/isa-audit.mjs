/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which instruction set extensions a title's programs use, found by reading
 * their code rather than by running it: what the engine executes, what it
 * answers #UD to as the processor it presents (a Nehalem: no AVX, FMA, BMI,
 * AES), and what runs but answers differently there (LZCNT is BSR on it).
 *
 *   node tools/isa-audit.mjs <file|directory|bundle.btl|disc.iso>... [--refused]
 *
 * Code is followed from where it is known to start along its branches, so
 * the data a compiler keeps among a function's instructions (LLVM's switch
 * and lookup tables) is never read as code. An x86-64 image starts at each
 * function its exception table (`.pdata`) lists, which is every function that
 * touches the stack: the share of functions an extension appears in tells a
 * program built for it (most of them) from one that picks a path by cpuid and
 * xgetbv (a few, asked first). An i386 image has no such table: it starts at
 * its entry, its exports and the addresses its relocations name in code, and
 * the share of instructions stands in for the share of functions. `--refused`
 * lists the opcodes cork's decoder does not take where a path met them.
 *
 * What this cannot see: a switch's cases reached only through its table, a
 * function only ever called through a register an i386 image computes, code
 * a packer keeps compressed until it runs, code a program writes at run time
 * (a JIT), and libraries it loads from elsewhere.
 */
import { gather } from './pe-files.mjs';
import { DIFFERENT, EXECUTED, MISSING, PROBES, walk } from './isa-scan.mjs';
import { DIR_BASERELOC, DIR_EXCEPTION, parsePe, readExports }
    from '../modules/core/src/layers/loader/internal/pe.js';

const argv = process.argv.slice(2);
const paths = argv.filter(arg=>!arg.startsWith('--'));
if (paths.length === 0)
{
    console.log('usage: node tools/isa-audit.mjs'
        + ' <file|directory|bundle.btl|disc.iso>... [--refused]');
    process.exit(2);
}
/** A base relocation that patches a 32-bit address (PE/COFF specification, 6.6.2). */
const REL_HIGHLOW = 3;

for (const found of (await Promise.all(paths.map(gather))).flat())
{
    /** @type {import('../modules/core/src/layers/loader/internal/pe.js').PeImage} */
    let image;
    try
    {
        image = parsePe(found.bytes, { wide: true });
    }
    catch (e){
        console.log(`unreadable ${found.where}: ${e instanceof Error ? e.message : e}`);
        continue;
    }
    const { bytes } = found;
    const sections = image.sections;
    /**
     * A byte of the image as it is mapped, by RVA; 0 where no file byte backs it.
     * @param {number} rva
     */
    const read = rva=>{
        for (const section of sections)
        {
            const offset = rva - section.virtualAddress;
            if (offset >= 0 && offset < Math.max(section.virtualSize, section.rawSize))
            {
                return offset < section.rawSize ? bytes[section.rawOffset + offset] ?? 0 : 0;
            }
        }
        return 0;
    };
    const code = sections.filter(section=>section.executable);
    /** @param {typeof sections[number]} section */
    const spanOf = section=>section.virtualSize || section.rawSize;
    const codeBytes = code.reduce((sum, section)=>sum + spanOf(section), 0);
    /** @param {number} rva */
    const inCode = rva=>code.some(section=>rva >= section.virtualAddress
        && rva < section.virtualAddress + spanOf(section));
    /** @param {number} offset */
    const word = offset=>(read(offset) | read(offset + 1) << 8 | read(offset + 2) << 16
        | read(offset + 3) << 24) >>> 0;
    /** @type {{ starts: number[], within: (address: number) => boolean }[]} */
    let groups = [];
    const exception = image.directories[DIR_EXCEPTION];
    if (image.bits === 64 && exception !== undefined && exception.size >= 12)
    {
        /** @type {Map<number, number>} */
        const ends = new Map();
        for (let at = exception.address; at + 12 <= exception.address + exception.size; at += 12)
        {
            const start = word(at);
            const end = word(at + 4);
            if (end > start && inCode(start))
            {
                ends.set(start, Math.max(end, ends.get(start) ?? 0));
            }
        }
        groups = [...ends].sort(([a], [b])=>a - b)
            .map(([start, end])=>({ starts: [start], within: rva=>rva >= start && rva < end }));
    }
    const byFunction = groups.length > 0;
    if (!byFunction)
    {
        // Where code is known to start: the entry, the exports, and every
        // address the relocations name in code, which is a function a table
        // points at or a switch's case, unless that address is relocated
        // itself, which makes it a table of addresses, not code.
        /** @type {Set<number>} */
        const sites = new Set();
        /** @type {number[]} */
        const named = [];
        const relocations = image.directories[DIR_BASERELOC];
        const relocationsEnd = relocations === undefined ? 0
            : relocations.address + relocations.size;
        for (let block = relocations?.address ?? 0; block + 8 <= relocationsEnd;)
        {
            const page = word(block);
            const size = word(block + 4);
            if (size < 8)
            {
                break;
            }
            for (let at = block + 8; at + 2 <= block + size; at += 2)
            {
                const entry = read(at) | read(at + 1) << 8;
                if (entry >> 12 === REL_HIGHLOW)
                {
                    const site = page + (entry & 0xfff);
                    sites.add(site);
                    named.push((word(site) - image.imageBase) >>> 0);
                }
            }
            block += size;
        }
        const starts = [image.entryPointRva, ...readExports(bytes, image).exports
            .filter(entry=>entry.forwards === null).map(entry=>entry.rva),
        ...named.filter(rva=>inCode(rva) && !sites.has(rva))];
        groups = [{ starts, within: inCode }];
    }
    /** In how many groups each extension appears. @type {Map<string, number>} */
    const runsWith = new Map();
    const scan = walk(read, groups, image.bits, extension=>{
        runsWith.set(extension, (runsWith.get(extension) ?? 0) + 1);
    });

    const kib = (/** @type {number} */ n)=>`${(n / 1024).toFixed(0)} KiB`;
    console.log(`${found.where}  ${image.bits === 64 ? 'x86-64' : 'i386'}, `
        + (byFunction ? `${groups.length} functions, `
            : `from ${groups[0].starts.length} known starts, `)
        + `${scan.instructions} instructions reached, `
        + `${kib(scan.bytes)} of ${kib(codeBytes)} of code`);
    /** @param {string} label @param {readonly string[]} names */
    const line = (label, names)=>{
        const present = names.filter(name=>scan.counts.has(name));
        if (present.length === 0)
        {
            return;
        }
        console.log(`  ${label.padEnd(10)} ` + present.map(name=>`${name} ${scan.counts.get(name)}`
            + (byFunction ? ` (${runsWith.get(name)} fn)` : '')).join(', '));
    };
    line('runs', EXECUTED);
    line('#UD here', MISSING);
    line('differs', DIFFERENT);
    line('asks', PROBES);

    const missing = MISSING.filter(name=>scan.counts.has(name));
    const widest = Math.max(0, ...missing.map(name=>runsWith.get(name) ?? 0));
    const asks = scan.counts.has('xgetbv') || scan.counts.has('cpuid');
    const share = missing.reduce((sum, name)=>sum + (scan.counts.get(name) ?? 0), 0)
        / Math.max(1, scan.instructions);
    // A program built for an extension has it all through its code; one that
    // picks a path has it in a few routines and asks the processor first.
    const chosen = asks && (byFunction ? widest / groups.length < 0.05 : share < 0.01);
    let verdict = 'within what the engine executes';
    if (missing.length > 0)
    {
        const where = byFunction ? `in up to ${widest} of ${groups.length} functions`
            : `${(share * 100).toFixed(2)} % of instructions`;
        verdict = chosen ? `a chosen path, most likely: ${missing.join(', ')} ${where},`
            + ' and the program asks cpuid/xgetbv'
            : `likely built for ${missing.join(', ')} (${where})`;
    }
    else if (scan.counts.has('LZCNT'))
    {
        verdict = 'runs, but its LZCNT executes as BSR here, as on a processor without it';
    }
    console.log(`  verdict    ${verdict}`);
    if (argv.includes('--refused') && scan.refused.size > 0)
    {
        const top = [...scan.refused].sort((a, b)=>b[1] - a[1]).slice(0, 12);
        console.log(`  refused    ${top.map(([opcode, n])=>`${opcode} ${n}`).join(', ')}`);
    }
}
