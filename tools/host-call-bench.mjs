/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a call from guest code into an import costs, in node: a small program
 * calls the import N times in a loop, and the same loop runs with the call's
 * pushes and pops but no call; the difference over N is the cost of one call
 * -- for a host handler the crossing out of translated code, the bridge's
 * dispatch, the arguments read from guest memory, the handler and the way
 * back; for an import that is code in the guest's own library, that code.
 *
 *   node tools/host-call-bench.mjs [N] [--rounds R] [--call SPEC]...
 *       [--engine cork|emulator] [--root DIR] [--baseline DIR] [--json]
 *   node tools/host-call-bench.mjs --compare BEFORE.json AFTER.json
 *   node tools/host-call-bench.mjs [N] --call SPEC --profile
 *
 * A SPEC is `DLL!name(arg,...)[:ret][@convention]`:
 *
 *   s:text   a pointer to that string (s:"a,b" for one with a comma)
 *   b:N      a pointer to N zeroed bytes
 *   i:N      a 32-bit integer (0x.. or decimal, negative too)
 *   d:X      a double on the stack, two slots
 *   x:X      a double pushed on the x87 stack before the call (_ftol, _CIsin)
 *   c:       a pointer to a cdecl comparator of two signed dwords, in the
 *            program's own code (qsort, bsearch)
 *
 *   :eax     the result in EAX (the default), or EDX:EAX
 *   :st0     a double left in ST0, which the loop pops
 *
 * The convention is cdecl for the C runtimes and stdcall for everything else,
 * as the engine's own tables have it, unless `@cdecl` or `@stdcall` says. The
 * default call is KERNEL32.dll!lstrlenA(s:a).
 *
 * Every call is timed in each of R rounds, in turn with the loop without it,
 * and printed as the median over the rounds and the spread: a run on a
 * loaded machine is spread, not faster or slower. The bridge's count of host
 * calls is printed beside it: an import that is code in the guest never
 * reaches the host, and one host call (the program's ExitProcess) says so.
 *
 * `--root DIR` times the engine of another checkout; `--baseline DIR` times
 * another checkout's too, round for round with this one's, and prints the
 * two side by side -- the way to set a host handler against the same
 * function as code in the guest, without a switch in the engine for it.
 * `--json` prints the results for `--compare`, which sets two runs side by
 * side. `--profile` runs the first call's loop once under the V8 profiler
 * started from inside this process (node:inspector) and prints the self time
 * of the functions the call spends it in.
 */

import { readFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildExe } from './make-pe.mjs';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The C runtimes, whose exports are cdecl -- the engine's own test of a library. */
const CDECL_LIBRARIES = /^(msvcrt|msvcr\d+d?|msvcp\d+d?|crtdll|ucrtbase)\.dll$/i;

/**
 * @typedef {{ kind: 's', text: string } | { kind: 'b', size: number }
 *     | { kind: 'i', value: number } | { kind: 'd', value: number }
 *     | { kind: 'x', value: number } | { kind: 'c' }} Arg
 */

/**
 * @typedef {Object} Spec
 * @property {string} text   As it was written.
 * @property {string} dll
 * @property {string} name
 * @property {Arg[]} args
 * @property {'eax' | 'st0'} returns
 * @property {'cdecl' | 'stdcall'} convention
 */

/**
 * @param {string} text
 * @returns {Spec}
 */
export function parseSpec(text){
    const match = /^([^!]+)!([^(]+)\((.*)\)(?::(eax|st0))?(?:@(cdecl|stdcall))?$/.exec(text);
    if (!match)
    {
        throw new Error(`a call is DLL!name(arg,...)[:eax|:st0][@cdecl|@stdcall]: ${text}`);
    }
    const [, dll, name, list, returns = 'eax', convention] = match;
    /** @type {Arg[]} */
    const args = [];
    let rest = list.trim();
    while (rest.length > 0)
    {
        const kind = rest[0];
        if (rest[1] !== ':' || !'sbidxc'.includes(kind))
        {
            throw new Error(`an argument is s:, b:, i:, d:, x: or c:, at "${rest}" in ${text}`);
        }
        rest = rest.slice(2);
        /** @type {string} */
        let value;
        if (kind === 's' && rest.startsWith('"'))
        {
            const end = /^"(?:[^"\\]|\\.)*"/.exec(rest);
            if (!end)
            {
                throw new Error(`an unterminated string in ${text}`);
            }
            value = JSON.parse(end[0]);
            rest = rest.slice(end[0].length);
        }
        else
        {
            const comma = rest.indexOf(',');
            value = comma < 0 ? rest : rest.slice(0, comma);
            rest = comma < 0 ? '' : rest.slice(comma);
        }
        rest = rest.replace(/^\s*,\s*/, '');
        if (kind === 's')
        {
            args.push({ kind, text: value });
        }
        else if (kind === 'b')
        {
            args.push({ kind, size: Number(value) });
        }
        else if (kind === 'c')
        {
            args.push({ kind });
        }
        else if (kind === 'i')
        {
            args.push({ kind, value: Number(value) });
        }
        else
        {
            args.push({ kind: /** @type {'d' | 'x'} */ (kind), value: Number(value) });
        }
    }
    return {
        text, dll, name, args, returns: /** @type {'eax' | 'st0'} */ (returns),
        convention: /** @type {'cdecl' | 'stdcall'} */ (convention
            ?? (CDECL_LIBRARIES.test(dll) ? 'cdecl' : 'stdcall')),
    };
}

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** @param {number} value */
const doubleWords = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/** Where the comparator a `c:` argument points at sits in the program's code. */
const COMPARATOR = 0x1c0;

/**
 * compare(a, b): the signed dwords at a and b, as -1, 0 or 1 -- a qsort
 * comparator as a compiler makes one.
 */
const COMPARATOR_CODE = [
    0x8b, 0x44, 0x24, 0x04, 0x8b, 0x00,     // mov eax, [esp+4]; mov eax, [eax]
    0x8b, 0x4c, 0x24, 0x08, 0x8b, 0x09,     // mov ecx, [esp+8]; mov ecx, [ecx]
    0x31, 0xd2, 0x39, 0xc8,                 // xor edx, edx; cmp eax, ecx
    0x0f, 0x9f, 0xc2, 0x0f, 0x9c, 0xc0,     // setg dl; setl al
    0x0f, 0xb6, 0xc0, 0x29, 0xc2, 0x89, 0xd0, 0xc3, // movzx eax, al; sub edx, eax; ...
];

/**
 * The loop: esi counts down from N; each turn loads the x87 arguments,
 * pushes the stack ones and either calls the import or takes them back off
 * itself, pops what the caller owns, and a double result.
 *
 * @param {Spec} spec @param {number} n @param {boolean} withCall
 */
export function program(spec, n, withCall){
    /** @type {Record<string, number[]>} */
    const data = {};
    spec.args.forEach((arg, i)=>{
        if (arg.kind === 's')
        {
            data[`a${i}`] = [...new TextEncoder().encode(arg.text), 0];
        }
        else if (arg.kind === 'b')
        {
            data[`a${i}`] = new Array(Math.max(arg.size, 1)).fill(0);
        }
        else if (arg.kind === 'x')
        {
            data[`a${i}`] = doubleWords(arg.value).flatMap(u32);
        }
    });
    const imports = /^kernel32\.dll$/i.test(spec.dll)
        ? { [spec.dll]: [spec.name, 'ExitProcess'] }
        : { [spec.dll]: [spec.name], 'KERNEL32.dll': ['ExitProcess'] };
    return buildExe({
        imports,
        data,
        codeSize: 0x200,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const turn = [];
            let slots = 0;
            let x87 = 0;
            for (const [i, arg] of spec.args.entries())
            {
                if (arg.kind === 'x')
                {
                    turn.push(0xdd, 0x05, ...u32(at(`a${i}`)));              // fld qword [x]
                    x87++;
                }
            }
            for (const [i, arg] of [...spec.args.entries()].reverse())
            {
                if (arg.kind === 's' || arg.kind === 'b')
                {
                    turn.push(0x68, ...u32(at(`a${i}`)));                    // push pointer
                    slots++;
                }
                else if (arg.kind === 'i')
                {
                    turn.push(0x68, ...u32(arg.value));                      // push value
                    slots++;
                }
                else if (arg.kind === 'c')
                {
                    turn.push(0x68, ...u32(code(COMPARATOR)));               // push comparator
                    slots++;
                }
                else if (arg.kind === 'd')
                {
                    const [low, high] = doubleWords(arg.value);
                    turn.push(0x68, ...u32(high), 0x68, ...u32(low));        // push the halves
                    slots += 2;
                }
            }
            if (withCall)
            {
                turn.push(0xff, 0x15, ...u32(iat(spec.name)));               // call [import]
                if (spec.convention === 'cdecl' && slots > 0)
                {
                    turn.push(0x83, 0xc4, slots * 4);                        // add esp, 4n
                }
                if (spec.returns === 'st0')
                {
                    turn.push(0xdd, 0xd8);                                   // fstp st0
                }
            }
            else
            {
                if (slots > 0)
                {
                    turn.push(0x83, 0xc4, slots * 4);                        // add esp, 4n
                }
                for (let i = 0; i < x87; i++)
                {
                    turn.push(0xdd, 0xd8);                                   // fstp st0
                }
            }
            const back = turn.length + 3;
            if (back > 128)
            {
                throw new Error(`${spec.text}: the loop's turn is too long for its jump`);
            }
            const loop = [
                0xbe, ...u32(n),                                             // mov esi, N
                ...turn,
                0x4e, 0x75, 0x100 - back,                                    // dec esi; jnz
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            if (loop.length > COMPARATOR)
            {
                throw new Error(`${spec.text}: the loop runs into the comparator`);
            }
            return [...loop, ...new Array(COMPARATOR - loop.length).fill(0xcc),
                ...COMPARATOR_CODE];
        },
    });
}

/**
 * The engine of a checkout, and what a launch under the emulator needs.
 *
 * @param {string} root @param {'cork' | 'emulator'} engine
 */
async function engineOf(root, engine){
    const { createApp } = await import(
        pathToFileURL(join(root, 'modules', 'core', 'src', 'app.js')).href);
    /** @type {Record<string, unknown>} */
    const extra = {};
    if (engine === 'emulator')
    {
        const prebuilt = join(root, 'modules', 'core', 'vendor', 'prebuilt');
        const wasm = await readFile(join(prebuilt, 'v86.wasm'));
        extra.v86 = {
            moduleUrl: pathToFileURL(join(prebuilt, 'libv86.mjs')).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        };
    }
    /** @param {Uint8Array} executable @returns {Promise<{ ms: number, calls: number }>} */
    return async executable=>{
        const app = await createApp({ executable, engine, ...extra });
        const started = performance.now();
        const code = await app.run({ timeoutMs: 600000, maxTurns: 1e9 });
        const ms = performance.now() - started;
        const calls = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge')
            ?.metrics?.calls ?? 0;
        await app.dispose();
        if (code !== 0)
        {
            throw new Error(`the program exited ${code}: a call the loop could not make?`);
        }
        return { ms, calls };
    };
}

/** @param {number[]} values */
function median(values){
    const sorted = [...values].sort((a, b)=>a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @typedef {Object} Result
 * @property {string} call
 * @property {string} tree   The checkout's label: `this`, `baseline`, or `root`.
 * @property {number[]} ns   A call's cost, each round.
 * @property {number} median
 * @property {number} min
 * @property {number} max
 * @property {number} hostCalls
 */

/** @param {Result[]} results @param {string[]} trees */
function table(results, trees){
    const calls = [...new Set(results.map(result=>result.call))];
    const width = Math.max(24, ...calls.map(call=>call.length));
    const header = [''.padEnd(width), ...trees.map(tree=>`${`${tree} ns/call`.padStart(16)} `
        + `${'min..max'.padStart(13)} ${'host calls'.padStart(11)}`)];
    if (trees.length === 2)
    {
        header.push('   ratio');
    }
    const lines = [header.join('  ')];
    for (const call of calls)
    {
        const row = [call.padEnd(width)];
        const medians = [];
        for (const tree of trees)
        {
            const found = results.find(result=>result.call === call && result.tree === tree);
            if (!found)
            {
                row.push(''.padStart(42));
                continue;
            }
            medians.push(found.median);
            row.push(`${found.median.toFixed(0).padStart(16)} `
                + `${`${found.min.toFixed(0)}..${found.max.toFixed(0)}`.padStart(13)} `
                + `${String(found.hostCalls).padStart(11)}`);
        }
        if (trees.length === 2 && medians.length === 2 && medians[1] !== 0)
        {
            row.push(`${(medians[0] / medians[1]).toFixed(2).padStart(8)}`);
        }
        lines.push(row.join('  '));
    }
    return lines.join('\n');
}

/** @param {string[]} argv */
function options(argv){
    /** @param {string} flag */
    const value = flag=>{
        const at = argv.indexOf(flag);
        return at >= 0 ? argv[at + 1] : undefined;
    };
    /** @type {string[]} */
    const calls = [];
    argv.forEach((arg, i)=>{
        if (arg === '--call' && argv[i + 1] !== undefined)
        {
            calls.push(argv[i + 1]);
        }
    });
    const engine = value('--engine') ?? 'cork';
    if (engine !== 'cork' && engine !== 'emulator')
    {
        throw new Error(`--engine is cork or emulator, not ${engine}`);
    }
    const flagged = new Set(['--rounds', '--call', '--engine', '--root', '--baseline',
        '--compare']);
    const positional = argv.filter((arg, i)=>!arg.startsWith('--')
        && !flagged.has(argv[i - 1] ?? ''));
    return {
        n: Number(positional[0] ?? 1_000_000),
        rounds: Number(value('--rounds') ?? 3),
        specs: (calls.length > 0 ? calls : ['KERNEL32.dll!lstrlenA(s:a)']).map(parseSpec),
        engine: /** @type {'cork' | 'emulator'} */ (engine),
        root: resolve(value('--root') ?? HERE),
        baseline: value('--baseline') === undefined ? null
            : resolve(/** @type {string} */ (value('--baseline'))),
        json: argv.includes('--json'),
        profile: argv.includes('--profile'),
        compare: argv.includes('--compare')
            ? argv.slice(argv.indexOf('--compare') + 1, argv.indexOf('--compare') + 3) : null,
    };
}

/** @param {ReturnType<typeof options>} o */
async function measure(o){
    /** @type {[string, string][]} */
    const trees = [[o.baseline === null && o.root !== HERE ? 'root' : 'this', o.root]];
    if (o.baseline !== null)
    {
        trees.unshift(['baseline', o.baseline]);
    }
    const runners = await Promise.all(trees.map(([, root])=>engineOf(root, o.engine)));
    const loops = o.specs.map(spec=>program(spec, o.n, false));
    const bodies = o.specs.map(spec=>program(spec, o.n, true));
    /** @type {Map<string, { ns: number[], hostCalls: number }>} */
    const collected = new Map();
    for (let round = 0; round < o.rounds; round++)
    {
        for (const [t, [tree]] of trees.entries())
        {
            for (const [s, spec] of o.specs.entries())
            {
                const loop = await runners[t](loops[s]);
                const calls = await runners[t](bodies[s]);
                const key = `${tree}\u0000${spec.text}`;
                const entry = collected.get(key) ?? { ns: [], hostCalls: 0 };
                entry.ns.push((calls.ms - loop.ms) * 1e6 / o.n);
                entry.hostCalls = calls.calls;
                collected.set(key, entry);
                if (!o.json)
                {
                    console.error(`round ${round} ${tree} ${spec.text}: `
                        + `${((calls.ms - loop.ms) * 1e6 / o.n).toFixed(0)} ns`);
                }
            }
        }
    }
    /** @type {Result[]} */
    const results = [];
    for (const [key, { ns, hostCalls }] of collected)
    {
        const [tree, call] = key.split('\u0000');
        results.push({ call, tree, ns, median: median(ns), min: Math.min(...ns),
            max: Math.max(...ns), hostCalls });
    }
    return { n: o.n, rounds: o.rounds, engine: o.engine,
        trees: Object.fromEntries(trees), results };
}

/** @param {ReturnType<typeof options>} o */
async function profile(o){
    const run = await engineOf(o.root, o.engine);
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    const { ms, calls } = await run(program(o.specs[0], o.n, true));
    const { profile: sampled } = await session.post('Profiler.stop');
    session.disconnect();
    /** @type {Map<number, any>} */
    const nodes = new Map(sampled.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<string, number>} */
    const self = new Map();
    let total = 0;
    sampled.samples.forEach((/** @type {number} */ id, /** @type {number} */ at)=>{
        const { callFrame } = nodes.get(id);
        const where = `${callFrame.functionName || '(anonymous)'} `
            + `${callFrame.url.split('/').slice(-2).join('/')}:${callFrame.lineNumber + 1}`;
        const us = sampled.timeDeltas[at] ?? 0;
        self.set(where, (self.get(where) ?? 0) + us);
        total += us;
    });
    console.log(`${calls} host calls in ${ms.toFixed(0)} ms, the program's start included`);
    for (const [where, us] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 30))
    {
        console.log(`${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * us / total).toFixed(1)
            .padStart(5)}%  ${where}`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    const o = options(process.argv.slice(2));
    if (o.compare)
    {
        const [before, after] = await Promise.all(o.compare.map(async path=>
            JSON.parse(await readFile(path, 'utf8'))));
        /** @param {any} run @param {string} label */
        const relabel = (run, label)=>run.results.map((/** @type {Result} */ result)=>
            ({ ...result, tree: Object.keys(run.trees).length > 1
                ? `${label} ${result.tree}` : label }));
        const results = [...relabel(before, 'before'), ...relabel(after, 'after')];
        console.log(table(results, [...new Set(results.map(result=>result.tree))]));
    }
    else if (o.profile)
    {
        await profile(o);
    }
    else
    {
        const measured = await measure(o);
        if (o.json)
        {
            console.log(JSON.stringify(measured, null, 2));
        }
        else
        {
            console.log(`N ${o.n}, ${o.rounds} rounds, ${o.engine}; ns a call is the median `
                + 'over the rounds');
            console.log(table(measured.results, Object.keys(measured.trees)));
        }
    }
}
