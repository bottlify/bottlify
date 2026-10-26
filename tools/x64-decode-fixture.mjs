/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit decoder's reference: x86-64 code as a compiler and an assembler
 * make it, read back by LLVM's disassembler, one line per instruction shape.
 *
 *   node tools/x64-decode-fixture.mjs [out]
 *
 * Two sources, both our own so the bytes carry no one else's licence: cork's
 * C interpreter (`interp-wasm.c`) compiled by clang for x86_64-pc-windows-msvc
 * at four optimisation levels, which is what a 64-bit Windows compiler emits
 * day to day; and `x64-edges.s` beside this tool, the encodings a compiler
 * seldom emits and a decoder easily gets wrong (REX byte registers, R12/R13 in
 * a SIB, 64-bit offsets, the address-size prefix, the defaults to 64 bits).
 * llvm-objdump disassembles both; an instruction is kept once per shape -- its
 * mnemonic and operands with every number taken out -- so the fixture holds
 * each register and addressing form without each displacement.
 *
 * Needs clang, llvm-mc and llvm-objdump (LLVM 18 here). The output is
 * `modules/cork/src/decode/x64-objdump.txt.gz`: lines of address, bytes,
 * mnemonic and operands, tab-separated, which `decoder64.test.js` decodes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? join(ROOT, 'modules/cork/src/decode/x64-objdump.txt.gz');
const work = mkdtempSync(join(tmpdir(), 'x64-fixture-'));

/** @param {string} command @param {string[]} args */
function run(command, args){
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.error || result.status !== 0)
    {
        console.error(`${command} ${args.join(' ')} failed:`,
            result.error?.message ?? result.stderr);
        process.exit(1);
    }
    return result.stdout;
}

/** @type {string[]} */
const objects = [];
for (const level of ['-O0', '-O1', '-O2', '-Os'])
{
    const object = join(work, `interp${level}.obj`);
    run('clang', [level, '-w', '-target', 'x86_64-pc-windows-msvc', '-c',
        join(ROOT, 'modules/cork/src/interp-wasm.c'), '-o', object]);
    objects.push(object);
}
const edges = join(work, 'edges.o');
run('llvm-mc', ['-triple', 'x86_64', '-filetype=obj', '-x86-asm-syntax=intel',
    join(ROOT, 'tools/x64-edges.s'), '-o', edges]);
objects.push(edges);

/** @type {Map<string, string>} */
const byShape = new Map();
for (const object of objects)
{
    const text = run('llvm-objdump', ['-d', '--x86-asm-syntax=intel', object]);
    for (const line of text.split('\n'))
    {
        const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*\t([^\t]+)(?:\t(.*))?$/.exec(line);
        if (match === null)
        {
            continue;
        }
        const [, address, bytes, mnemonic, rest = ''] = match;
        // The target's symbol and the comment's are the disassembler's
        // annotations; the comment keeps the RIP-relative target.
        const operands = rest.replace(/ <[^>]*>/g, '').trim();
        const shape = `${mnemonic} ${operands.replace(/#.*$/, '')
            .replace(/-?0x[0-9a-f]+|\b\d+\b/g, '#')}`;
        if (!byShape.has(shape))
        {
            byShape.set(shape, [address, bytes.replace(/ /g, ''), mnemonic, operands].join('\t'));
        }
    }
}
writeFileSync(OUT, gzipSync(`${[...byShape.values()].join('\n')}\n`, { level: 9 }));
console.log(`${byShape.size} instruction shapes -> ${OUT} (${readFileSync(OUT).length} bytes)`);
