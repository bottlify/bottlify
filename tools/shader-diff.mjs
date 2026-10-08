/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Our HLSL compiler against Microsoft's, by running what each made.
 *
 * Reads a directory of shaders as a harness run writes them (`game.mjs`,
 * `game-<stamp>-shaders/`: `NNN-<profile>-<entry>.hlsl` with the program's
 * macros at the top, its includes beside it), compiles each with our compiler
 * and with the system's D3DCompiler_47 (Windows only, through PowerShell), and
 * runs both programs on the reference machine with the same random inputs,
 * constants and textures -- matched by semantic, by constant name and by
 * sampler name, since the two compilers place them differently. Bytecode two
 * compilers wrote differently cannot be compared token by token; what it
 * computes can.
 *
 * D3DCompiler_47 has no pixel shader model 1, so a ps_1_x shader is compared
 * with Microsoft's ps_2_0 of the same source, both outputs saturated as the
 * render target takes them; a model 1 register clamps to -1..1, so the inputs
 * and constants are drawn from 0..1 and a difference left is the compiler's.
 * With --legacy and the path of d3dx9_31.dll -- the DirectX runtime's last
 * compiler with the model 1 targets; its x86 build is loaded into a 32-bit
 * PowerShell -- model 1 shaders are compiled by it for their own profile instead.
 *
 *     node tools/shader-diff.mjs <dir> [--trials N] [--only NNN] [--legacy d3dx9_31.dll]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileShader } from '../modules/core/src/layers/win32/d3dx9/hlsl-compile.js';
import { parseConstantTable } from '../modules/core/src/layers/win32/d3dx9/constants.js';
import { decode, execute } from '../modules/core/src/layers/win32/d3dx9/d3d9-machine.fixture.js';

const FXC = resolve(fileURLToPath(new URL('.', import.meta.url)), 'shader-diff-fxc.ps1');
const argv = process.argv.slice(2);
const dir = argv.find(a=>!a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--trials'
    && argv[argv.indexOf(a) - 1] !== '--only' && argv[argv.indexOf(a) - 1] !== '--legacy');
const trials = argv.includes('--trials') ? Number(argv[argv.indexOf('--trials') + 1]) : 32;
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const legacy = argv.includes('--legacy') ? argv[argv.indexOf('--legacy') + 1] : null;
if (!dir || !existsSync(dir))
{
    console.error('usage: node tools/shader-diff.mjs <dir> [--trials N] [--only NNN]'
        + ' [--legacy d3dx9_31.dll]');
    process.exit(2);
}

/** A number from a seed and a key, in 0..1: the same for both programs. @param {string} key */
function unit(key){
    let h = 2166136261;
    for (let i = 0; i < key.length; i++)
    {
        h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    }
    h = Math.imul(h ^ h >>> 15, 0x2c1b3c6d);
    h = Math.imul(h ^ h >>> 12, 0x297a2d39);
    return ((h ^ h >>> 15) >>> 0) / 4294967296;
}

/** Name to registers, from the CTAB block in a program's tokens. @param {any} program */
function constantsOf(program){
    /** @type {Map<string, { set: number, index: number, count: number, type: number }>} */
    const named = new Map();
    const block = program.constantTable;
    if (!block)
    {
        return named;
    }
    // The payload starts with the fourcc; the table's offsets count from after it.
    const body = block.subarray(4);
    const table = parseConstantTable(
        new DataView(body.buffer, body.byteOffset, body.byteLength), 0);
    for (const c of table.constants)
    {
        named.set(c.name, { set: c.set, index: c.index, count: c.count, type: c.type });
    }
    return named;
}

/**
 * The machine's inputs for one trial: constants by name, inputs by semantic, a
 * texture that answers by its sampler's name and the coordinate.
 *
 * @param {any} program @param {number} trial
 */
function ioFor(program, trial){
    const f = new Float32Array(256 * 4);
    const ints = new Int32Array(16 * 4);
    const bools = new Array(16).fill(false);
    const named = constantsOf(program);
    /** @type {Map<number, string>} */
    const samplerName = new Map();
    for (const [name, c] of named)
    {
        if (c.set === 3)
        {
            for (let k = 0; k < c.count; k++)
            {
                samplerName.set(c.index + k, `${name}#${k}`);
            }
            continue;
        }
        // An int or a bool holds a whole number wherever it lives, as a program sets it: a
        // fraction there is a value no program gives, which two compilers may read apart.
        const whole = c.type === 1 || c.type === 2;
        for (let r = 0; r < c.count * 4; r++)
        {
            const x = unit(`${trial}:${name}:${r}`);
            const value = !whole ? x : c.type === 1 ? (x < 0.5 ? 0 : 1) : Math.floor(x * 4);
            if (c.set === 1)
            {
                ints[c.index * 4 + r] = value;
            }
            else if (c.set === 0)
            {
                if (r % 4 === 0)
                {
                    bools[c.index + r / 4] = value !== 0;
                }
            }
            else
            {
                f[c.index * 4 + r] = value;
            }
        }
    }
    for (const [index, values] of program.defs.f)
    {
        f.set(values, index * 4);
    }
    /** @type {number[][]} */
    const v = [];
    /** @type {number[][]} */
    const t = [];
    const lane = (/** @type {string} */ key)=>[0, 1, 2, 3].map(i=>unit(`${trial}:${key}:${i}`));
    for (let i = 0; i < 16; i++)
    {
        // A pixel shader's inputs are the colours (v#) and the coordinate sets (t#) in
        // every model; a vertex shader's are placed by the usage they were declared with.
        v[i] = lane(`color${i}`);
        t[i] = lane(`texcoord${i}`);
    }
    if (program.kind === 'vertex')
    {
        for (const decl of program.declarations)
        {
            if (decl.register.startsWith('v') && decl.usage)
            {
                v[decl.index] = lane(`${decl.usage}${decl.usageIndex}`);
            }
        }
    }
    return {
        constants: { f, i: ints, b: bools },
        inputs: { v, t },
        position: /** @type {[number, number]} */ ([0.5, 0.5]),
        frontFacing: true,
        /** @param {number} sampler @param {string} dimension @param {number[]} coord */
        sample: (sampler, dimension, coord)=>{
            // A 2D texture reads two coordinates, whatever else the register holds: one
            // compiler declares t0.xy, the other reads all of t0.
            const key = `${trial}:${samplerName.get(sampler) ?? `s${sampler}`}:${
                coord.slice(0, dimension === '2d' ? 2 : 3).map(x=>Math.round(x * 64)).join(',')}`;
            return [0, 1, 2, 3].map(i=>unit(`${key}:${i}`));
        },
        derivative: ()=>[0, 0, 0, 0],
    };
}

/** @param {number} x */
const saturate = x=>Math.min(1, Math.max(0, x));

/** The outputs worth comparing, keyed by semantic, as the render target would take them. */
function outputsOf(/** @type {any} */ result, /** @type {boolean} */ pixel){
    /** @type {Record<string, number[]>} */
    const out = {};
    for (const [name, values] of Object.entries(result.outputs))
    {
        const semantic = result.semantics?.[name];
        const key = semantic ? `${semantic.usage}${semantic.index}` : name;
        // Fog and point size are one number; what else a compiler writes there is unread.
        const read = /fog|psize|oFog|oPts/i.test(key) ? values.slice(0, 1) : values;
        out[key] = read.map((/** @type {number} */ x)=>(pixel ? saturate(x) : x));
    }
    return out;
}

const files = readdirSync(dir).filter(name=>/^\d+-[pv]s_\d_\w+-.+\.hlsl$/.test(name)
    && (!only || name.startsWith(only))).sort();
/** @param {string} file */
const partsOf = file=>{
    const [, profile, entry] = /^\d+-([pv]s_\d_\w)-(.+)\.hlsl$/.exec(file) ?? [];
    const model1 = /^[pv]s_1_/.test(profile);
    return { profile, entry, legacy: Boolean(legacy) && model1,
        refProfile: /^ps_1_/.test(profile) && !legacy ? 'ps_2_0' : profile };
};
// Every reference compile in one process: loading the compiler costs more than a compile.
const list = join(dir, 'shader-diff.list');
writeFileSync(list, files.map(file=>{
    const { refProfile, entry, legacy: old } = partsOf(file);
    const out = resolve(dir, `${file}.ref-${refProfile}.bin`);
    return `${resolve(dir, file)}|${refProfile}|${entry}|${out}${old ? '|legacy' : ''}`;
}).join('\n'));
/**
 * The PowerShell that can load the legacy DLL: a 32-bit one for an x86 build, which
 * runs on every Windows -- on ARM64 the default PowerShell is native and loads
 * neither an x64 nor an x86 library.
 */
const shell = legacy && readFileSync(legacy).readUInt16LE(
    readFileSync(legacy).readUInt32LE(0x3c) + 4) === 0x14c
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0',
        'powershell.exe')
    : 'powershell';
execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FXC,
    '-List', list, ...(legacy ? ['-Legacy', legacy] : [])], { stdio: 'inherit' });

/** @type {Record<string, string[]>} */
const verdicts = { same: [], 'values differ': [], fault: [], 'ours refuses, Microsoft compiles': [],
    'ours compiles, Microsoft refuses': [], 'both refuse': [] };
for (const file of files)
{
    const { profile, entry, refProfile } = partsOf(file);
    const source = readFileSync(join(dir, file), 'latin1');
    let ours;
    try
    {
        ours = await compileShader(source, { profile, entry,
            include: async(/** @type {string} */ name)=>{
                const path = join(dir, name.replace(/[\\/:*?"<>|]/g, '_'));
                return existsSync(path) ? readFileSync(path, 'latin1') : null;
            } });
    }
    catch (e){
        ours = { tokens: null, messages: `threw: ${/** @type {Error} */ (e).message}` };
    }
    const refOut = join(dir, `${file}.ref-${refProfile}.bin`);
    const refText = existsSync(`${refOut}.txt`) ? readFileSync(`${refOut}.txt`, 'latin1') : '';
    const label = `${file} (ours ${profile}, Microsoft ${refProfile})`;
    const firstError = (/** @type {string} */ text)=>text.split('\n')
        .find(line=>/error|threw|FAILED/.test(line))?.trim() ?? text.trim().split('\n').pop();
    if (!ours.tokens || !existsSync(refOut))
    {
        const kind = ours.tokens ? 'ours compiles, Microsoft refuses'
            : existsSync(refOut) ? 'ours refuses, Microsoft compiles' : 'both refuse';
        const said = ours.tokens ? 'compiles' : firstError(ours.messages);
        verdicts[kind].push(`${label}\n    ours: ${said}`
            + `\n    Microsoft: ${existsSync(refOut) ? 'compiles' : firstError(refText)}`);
        continue;
    }
    const refBytes = readFileSync(refOut);
    let worst = { error: 0, where: '', ours: /** @type {number[]} */ ([]),
        ref: /** @type {number[]} */ ([]) };
    let fault = null;
    try
    {
        // Held to what the device runs, not to a card's limits: a compiler may go past those.
        const ourProgram = decode(ours.tokens, { wide: true });
        const refProgram = decode(new Uint32Array(refBytes.buffer, refBytes.byteOffset,
            refBytes.byteLength / 4), { wide: true });
        const pixel = ourProgram.kind === 'pixel';
        for (let trial = 0; trial < trials; trial++)
        {
            const a = outputsOf(execute(ourProgram, ioFor(ourProgram, trial)), pixel);
            const b = outputsOf(execute(refProgram, ioFor(refProgram, trial)), pixel);
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
            {
                const x = a[key] ?? [];
                const y = b[key] ?? [];
                for (let i = 0; i < 4; i++)
                {
                    const both = Number.isNaN(x[i] ?? NaN) && Number.isNaN(y[i] ?? NaN);
                    const error = both ? 0 : Math.abs((x[i] ?? NaN) - (y[i] ?? NaN));
                    if (!(error <= worst.error))
                    {
                        worst = { error: Number.isNaN(error) ? Infinity : error,
                            where: `${key}.${'xyzw'[i]} trial ${trial}`, ours: x, ref: y };
                    }
                }
            }
        }
    }
    catch (e){
        fault = /** @type {Error} */ (e).message;
    }
    if (fault)
    {
        verdicts.fault.push(`${label}\n    ${fault}`);
    }
    else if (worst.error > 2e-3)
    {
        verdicts['values differ'].push(`${label}\n    worst ${worst.error.toFixed(4)} at ${
            worst.where}: ours [${worst.ours.map(x=>x.toFixed(4))}] Microsoft [${
            worst.ref.map(x=>x.toFixed(4))}]`);
    }
    else
    {
        verdicts.same.push(label);
    }
}
for (const [kind, entries] of Object.entries(verdicts))
{
    if (kind === 'same' || entries.length === 0)
    {
        continue;
    }
    console.log(`\n== ${kind}: ${entries.length}`);
    for (const one of entries)
    {
        console.log(one);
    }
}
console.log(`\n${files.length} shaders: ${Object.entries(verdicts)
    .map(([kind, entries])=>`${entries.length} ${kind}`).join(', ')}`);
const failed = files.length - verdicts.same.length - verdicts['both refuse'].length;
process.exit(failed > 0 ? 1 : 0);
