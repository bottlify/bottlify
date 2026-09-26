/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes world.c to stdout: a program shaped like a game's frame rather than one
 * loop -- thousands of functions in hundreds of batches, what a translator's
 * modules and the transfers between them are made of in a real title.
 *
 * Each call of `main` is a frame. Entities of 48 types update through a table of
 * eight methods each, the way C++ virtual calls compile: polymorphic calls whose
 * targets shift as a few entities change type every sixteen frames. Then the
 * frame runs one of 48 phases -- a menu, a level, a loading screen -- each 64
 * functions of loops, branches and calls into 32 small helpers every phase
 * shares, into 64 engine functions too big to form into a caller, and into the
 * phase's own functions, directly and through a table; the phase moves on every
 * sixteen frames, so new code keeps arriving for 768 frames and then comes round
 * again, calling into code translated long before. The structure is drawn from
 * a fixed seed, so the program is the same at every build.
 *
 *   node src/world.mjs > world.c
 */

const TYPES = 48;
const METHODS = 8;
const ENTITIES = 512;
const PHASES = 48;
const PER_PHASE = 64;
const HELPERS = 32;
const FRAMES_PER_PHASE = 16;
const ENGINE = 64;

let seed = 0x2545f491;
/** @param {number} n */
const random = n=>{
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
};
/** A constant for a body. */
const k = ()=>`${(Math.imul(random(1 << 24), 2654435761) >>> 0) | 1}u`;

/** What keeps each function a function of its own at -O2. */
const NOINLINE = '__attribute__((noinline))';
const out = ['typedef unsigned int u32;', 'typedef struct Ent Ent;',
    `typedef struct { u32 (*m[${METHODS}])(Ent *); } VT;`,
    'struct Ent { const VT *vt; u32 f[4]; u32 state; };', 'typedef u32 (*P)(u32);'];

// The helpers every phase and every method calls: small leaves, a module's
// most crossed-into functions once the callers are spread over many.
const helpers = [
    'return x * 2654435761u >> 7;',
    'return (x ^ x >> 13) * 0x5bd1e995u;',
    'return x > 1000u ? 1000u : x;',
    'return (x << 5 | x >> 27) + 0x9e3779b9u;',
    'return x & 1 ? x * 3u + 1u : x >> 1;',
    'return (x & 0xffffu) * (x >> 16) + 7u;',
    'return x - (x >> 3) + (x >> 9);',
    'u32 s = 0; while (x) { s += x & 15u; x >>= 4; } return s;',
];
for (let h = 0; h < HELPERS; h++)
{
    out.push(`${NOINLINE} u32 h${h}(u32 x){ x ^= ${k()}; ${helpers[h % helpers.length]} }`);
}
const helper = ()=>`h${random(HELPERS)}`;

// The methods, each a few statements on an entity's fields with a helper or two.
for (let t = 0; t < TYPES; t++)
{
    for (let m = 0; m < METHODS; m++)
    {
        const a = random(4);
        const b = (a + 1 + random(3)) & 3;
        const body = [`e->f[${a}] = e->f[${a}] * ${k()} + ${helper()}(e->f[${b}]);`];
        if (random(2) === 0)
        {
            body.push(`if (e->f[${b}] & ${1 << random(8)}u) e->state += ${helper()}(e->state);`,
                `else e->f[${b}] ^= e->state >> ${1 + random(7)};`);
        }
        if (random(3) === 0)
        {
            body.push(`for (u32 i = 0; i < (e->f[${a}] & 7u); i++)`
                + ` e->f[${b}] += ${helper()}(i + e->f[${a}]);`);
        }
        body.push(`return e->f[${a}] ^ e->f[${b}] ^ ${m === 2 ? 'e->state & 1u' : 'e->state'};`);
        out.push(`${NOINLINE} static u32 t${t}m${m}(Ent *e){ ${body.join(' ')} }`);
    }
}
out.push(`static const VT vts[${TYPES}] = {`);
for (let t = 0; t < TYPES; t++)
{
    out.push(`  {{ ${Array.from({ length: METHODS }, (_, m)=>`t${t}m${m}`).join(', ')} }},`);
}
out.push('};');

// The phases: each function a loop over a helper or two, a call to the phase's
// function before it (a chain of up to eight), and one in four a call through
// the phase's own table of four.
for (let e = 0; e < ENGINE; e++)
{
    out.push(`u32 e${e}(u32 x);`);
}
for (let p = 0; p < PHASES; p++)
{
    out.push(`extern P const table${p}[4];`);
    for (let i = 0; i < PER_PHASE; i++)
    {
        const body = [`u32 a = x ^ ${k()}, b = ${k()};`,
            `for (u32 j = 0; j < (x & 3u) + ${2 + random(6)}u; j++) {`,
            `  a = a * ${k()} + (b >> ${1 + random(9)});`,
            `  if (a & ${1 << random(10)}u) b += ${helper()}(a); else b ^= ${helper()}(b + j);`,
            ...(i % 2 === 1 ? [`  b ^= e${(p * 7 + i) % ENGINE}(a + j);`] : []),
            '}'];
        if (i % 8 !== 0)
        {
            body.push(`a += p${p}f${i - 1}(b);`);
        }
        if (i % 4 === 3)
        {
            body.push(`a ^= table${p}[a >> 3 & 3u](b);`);
        }
        if (random(2) === 0)
        {
            body.push(`if ((a ^ b) & ${1 << random(12)}u)`
                + ` { b = b * ${k()} ^ ${helper()}(a); a += b >> 3; }`);
        }
        body.push('return a ^ b;');
        out.push(`${NOINLINE} u32 p${p}f${i}(u32 x){ ${body.join(' ')} }`);
    }
    // Only the chains' first functions, which call nothing of the phase's.
    const firsts = Array.from({ length: 4 }, ()=>`p${p}f${random(PER_PHASE / 8) * 8}`);
    out.push(`P const table${p}[4] = { ${firsts.join(', ')} };`);
}
// The engine: functions every phase calls in its loops, each a switch over
// eight cases -- no leaf, so a call to one leaves its caller's region, and
// one from a phase's new code into the engine's old code crosses modules.
for (let e = 0; e < ENGINE; e++)
{
    const cases = Array.from({ length: 8 }, (_, c)=>(c % 2 === 0
        ? `case ${c}: a = a * ${k()} + ${helper()}(a); break;`
        : `case ${c}: a ^= (a >> ${1 + random(15)}) + ${k()}; break;`));
    out.push(`${NOINLINE} u32 e${e}(u32 x){ u32 a = x ^ ${k()};`,
        '  for (u32 j = 0; j < (x & 3u) + 3u; j++)',
        `    switch (a >> (j & 7u) & 7u) { ${cases.join(' ')} }`, '  return a;', '}');
}

// Each phase's entries, the chains' ends, called through one table as a game
// calls a screen's handlers.
out.push(`static P const roots[${PHASES}][${PER_PHASE / 8}] = {`);
for (let p = 0; p < PHASES; p++)
{
    const ends = Array.from({ length: PER_PHASE / 8 }, (_, r)=>`p${p}f${r * 8 + 7}`);
    out.push(`  { ${ends.join(', ')} },`);
}
out.push('};');

out.push(`static Ent ents[${ENTITIES}];`, 'static u32 frame;', 'int main(void){');
out.push('  if (frame == 0)', `    for (u32 i = 0; i < ${ENTITIES}u; i++){`,
    `      ents[i].vt = &vts[(i * 7u) % ${TYPES}u];`,
    '      for (u32 j = 0; j < 4; j++) ents[i].f[j] = i * 2654435761u + j;',
    '      ents[i].state = i;', '    }');
out.push('  u32 sum = 0;', `  for (u32 i = 0; i < ${ENTITIES}u; i++){`, '    Ent *e = &ents[i];',
    '    e->vt->m[0](e);', '    e->vt->m[1](e);', '    if (e->vt->m[2](e)) sum += e->vt->m[3](e);',
    '    if ((i & 7u) == (frame & 7u)) sum ^= e->vt->m[4u + (frame >> 3 & 3u)](e);',
    '  }');
out.push(`  u32 p = frame / ${FRAMES_PER_PHASE}u % ${PHASES}u;`);
out.push(`  for (u32 r = 0; r < 4u; r++) for (u32 c = 0; c < ${PER_PHASE / 8}u; c++)`
    + ' sum += roots[p][c](sum + r);');
out.push(`  if (frame % ${FRAMES_PER_PHASE}u == 0)`, '    for (u32 i = 0; i < 16u; i++)',
    `      ents[(frame * 7u + i * 37u) % ${ENTITIES}u].vt`
        + ` = &vts[(frame / ${FRAMES_PER_PHASE}u + i) % ${TYPES}u];`);
out.push('  frame++;', '  return (int)sum;', '}');
console.log(out.join('\n'));
