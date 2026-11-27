/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes load.c to stdout: a loading phase's shape -- fifteen hundred distinct
 * small functions (loops over tables, byte scans, switches, bit twiddling,
 * stores), each called one to six times -- so what code run a handful of times
 * costs the engine is measured, where the other workloads are hot loops.
 */

const FUNCTIONS = 1500;
let seed = 5;
/** @param {number} n */
const random = n=>{
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
};

const out = [
    'typedef unsigned int u32;',
    'static u32 data[4096];',
    'static unsigned char bytes[8192];',
];
for (let i = 0; i < FUNCTIONS; i++)
{
    const a = 1 + random(96);
    const b = 3 + random(28);
    const c = 2 + random(15);
    const bodies = [
        `u32 s = x; for (int i = 0; i < ${b}; i++) s = s * ${a} + data[(s + i) & 4095]; return s;`,
        `u32 s = 0; for (int i = 0; i < ${b * 4}; i++) s += bytes[(x + i * ${c}) & 8191] ^ ${a};`
            + ' return s;',
        `switch (x % ${c}) { ${Array.from({ length: c }, (_, j)=>`case ${j}: x = x * ${a + j}`
            + ` + ${j}; break;`).join(' ')} } return x;`,
        `u32 s = x; for (int i = 0; i < ${b}; i++) { if (s & 1) s = (s >> 1) ^ ${random(1 << 30)}u;`
            + ` else s >>= 1; data[(i * ${a}) & 4095] += s; } return s;`,
        `u32 s = x; for (int i = ${b}; i > 0; i--) s ^= (s << ${c % 7 + 1}) + data[i & 4095];`
            + ` return s + ${a};`,
        `for (int i = 0; i < ${b}; i++) bytes[(x + i) & 8191] = (unsigned char)(x >> (i & 7));`
            + ` return x * ${a};`,
    ];
    out.push(`__attribute__((noinline)) static u32 f${i}(u32 x) { ${bodies[random(6)]} }`);
}
out.push('int main(void) { u32 s = 1;');
for (let i = 0; i < FUNCTIONS; i++)
{
    out.push(`  for (int r = 0; r < ${1 + (i * 7919) % 6}; r++) s = f${i}(s + r);`);
}
out.push('  return (int)s; }');
console.log(out.join('\n'));
