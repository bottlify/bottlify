/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes calls.c to stdout: N small distinct functions called through a table of pointers,
 * 32768 calls an iteration whatever N is -- in the table's order (`order`) or scattered
 * over it by an odd stride (`scatter`) -- so what a transfer between translated regions
 * costs is measured against how many distinct targets it has, the one thing that changes.
 *
 *   node src/calls.mjs N order|scatter > calls.c      (N a power of two)
 */

const [n = '512', pattern = 'order'] = process.argv.slice(2);
const N = Number(n);
if (!(N > 0 && (N & N - 1) === 0) || !['order', 'scatter'].includes(pattern))
{
    throw new Error('calls.mjs: N a power of two, then order or scatter');
}
const CALLS = 32768;
const out = ['typedef unsigned int u32;', 'typedef u32 (*F)(u32);'];
for (let i = 0; i < N; i++)
{
    // Distinct constants, so no two bodies are folded into one function.
    out.push(`__attribute__((noinline)) static u32 f${i}(u32 x)`
        + ` { return (x ^ ${(i * 2654435761) >>> 0}u) * 2246822519u + (x >> 7); }`);
}
// Not const and not static: the compiler may not read the calls' targets out of it.
out.push(`F table[${N}] = {`);
for (let i = 0; i < N; i += 16)
{
    out.push(`  ${Array.from({ length: Math.min(16, N - i) }, (_, j)=>`f${i + j}`).join(', ')},`);
}
out.push('};');
const index = pattern === 'order' ? 'i' : `(i * 2654435761u) & ${N - 1}u`;
out.push('int main(void) {', '  u32 s = 1;');
out.push(`  for (u32 r = 0; r < ${CALLS / N}u; r++)`);
out.push(`    for (u32 i = 0; i < ${N}u; i++) s = table[${index}](s + r);`);
out.push('  return (int)s;', '}');
console.log(out.join('\n'));
