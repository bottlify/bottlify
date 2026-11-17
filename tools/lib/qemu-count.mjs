/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the counting stands share (`tools/translator/emit-count.mjs`,
 * `run-count.mjs`, `pe-count.mjs`): node run under a qemu built with plugins - qemu-x86_64, or
 * qemu-aarch64 with an arm64 node (`Target`) - and the
 * plugin `qemu-count.c`, which prints its totals of machine instructions, by
 * where the code lies, at every `fdatasync` the program makes - a mark - and
 * at its end. A tree's count repeats to the instruction where time on this
 * machine varies by a tenth.
 *
 * node runs on one thread and predictably, so its compiles and collections
 * fall in the same place every run; its young generation is held at 64 MiB and
 * its old one past what a run reaches, since the predictable collection
 * schedule makes the old generation's marking fall wherever a pass's garbage
 * crosses a fixed step. V8's optimising compiles are counted apart
 * (`compile`): each lands in the pass that crossed its threshold, and a stand
 * judges an arm by the rest (`work`).
 */

import { existsSync, fdatasyncSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** node's flags under the count. */
export const COUNT_NODE_FLAGS = Object.freeze(['--single-threaded', '--predictable',
    '--no-flush-bytecode', '--min-semi-space-size=64', '--max-semi-space-size=64',
    '--initial-old-space-size=4096']);

/** The plugin's kinds of code, in the order it prints them. */
export const KINDS = /** @type {const} */ (['js', 'compile', 'gc', 'other']);

/** @typedef {{ js: number, compile: number, gc: number, other: number }} Kinds */

/**
 * A mark in the count, from inside the counted program: the plugin prints its
 * totals at every fdatasync, which nothing else in node calls (on a pipe it
 * fails, and is made all the same).
 */
export const mark = ()=>{
    try
    {
        fdatasyncSync(1);
    }
    catch {
        // EINVAL on a pipe: the call was made, which is all a mark is.
    }
};

/** What a stand judges by: every kind but V8's own compiles. @param {Kinds} kinds */
export const work = kinds=>kinds.js + kinds.gc + kinds.other;

/**
 * The machine a count is taken on: this node's own (x86-64) unless an arm64 node is named -
 * then that node runs under `qemu-aarch64`, and the count is of the code V8 makes for arm64.
 *
 * @typedef {object} Target
 * @property {string} [arm64]    an arm64 node's path
 * @property {string} [sysroot]  where the arm64 loader and libc are (`/usr/aarch64-linux-gnu`)
 * @property {string} [lib]      a directory of further arm64 libraries the node needs
 * @property {string[]} [flags]  further flags of the counted node (`--no-wasm-bounds-checks`:
 *     V8 as it is on macOS arm64, where a store past the memory is left to the fault)
 */

/** fdatasync's number on each counted machine. */
const MARK_SYSCALL = Object.freeze({ x86_64: 75, aarch64: 83 });

/**
 * The stands' own arguments that name the counted machine, taken from `argv` at `i`:
 * `--arm64 NODE`, `--sysroot DIR`, `--lib DIR`, `--node-flags 'A B'`. Answers how many
 * arguments it took, 0 for one that is not its own.
 *
 * @param {Target} target @param {string[]} argv @param {number} i
 */
export function takeTarget(target, argv, i){
    const name = argv[i];
    if (name === '--arm64' || name === '--sysroot' || name === '--lib')
    {
        target[/** @type {'arm64' | 'sysroot' | 'lib'} */ (name.slice(2))] = argv[i + 1];
        return 2;
    }
    if (name === '--node-flags')
    {
        target.flags = argv[i + 1].split(/\s+/).filter(Boolean);
        return 2;
    }
    return 0;
}

/**
 * The plugin, built beside the qemu binary the first time, or again when its
 * source is newer; refused, said, when the directory holds no qemu to count
 * with.
 *
 * @param {string} dir  holds the qemu (`qemu-x86_64`, or `qemu-aarch64` for an arm64 count)
 *     and `qemu-plugin.h`
 * @param {'x86_64' | 'aarch64'} [machine]
 */
export function countPlugin(dir, machine = 'x86_64'){
    const source = fileURLToPath(new URL('qemu-count.c', import.meta.url));
    const built = `${dir}/qemu-count${machine === 'x86_64' ? '' : `-${machine}`}.so`;
    if (!existsSync(`${dir}/qemu-${machine}`) || !existsSync(`${dir}/qemu-plugin.h`))
    {
        throw new Error(`not measured: --qemu ${dir || '(none)'} holds no qemu-${machine} and `
            + 'qemu-plugin.h (a qemu built with --enable-plugins)');
    }
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs)
    {
        const glib = execFileSync('pkg-config', ['--cflags', 'glib-2.0'], { encoding: 'utf8' })
            .trim().split(/\s+/);
        execFileSync('gcc', ['-shared', '-fPIC', '-O2', `-DMARK_SYSCALL=${MARK_SYSCALL[machine]}`,
            ...glib, `-I${dir}`, source, '-o', built]);
    }
    return built;
}

/**
 * A node script run under the count: its standard output, and the plugin's
 * totals at each of its marks.
 *
 * @param {string} dir  the qemu's (`countPlugin`)
 * @param {string[]} args  the script and its arguments
 * @param {Record<string, string>} [env]
 * @param {Target} [target]  the counted machine, this node's own unless given
 * @returns {Promise<{ marks: Kinds[], out: string }>}
 */
export function runCounted(dir, args, env = {}, target = {}){
    const machine = target.arm64 === undefined ? 'x86_64' : 'aarch64';
    const plugin = countPlugin(dir, machine);
    if (target.arm64 !== undefined && !existsSync(target.arm64))
    {
        throw new Error(`not measured: --arm64 ${target.arm64} is no file`);
    }
    const emulated = target.arm64 === undefined ? []
        : ['-L', target.sysroot ?? '/usr/aarch64-linux-gnu',
            ...target.lib === undefined ? [] : ['-E', `LD_LIBRARY_PATH=${target.lib}`]];
    return new Promise((resolve, reject)=>{
        const run = spawn(`${dir}/qemu-${machine}`, [...emulated, '-plugin', plugin,
            target.arm64 ?? process.execPath, ...COUNT_NODE_FLAGS, ...target.flags ?? [], ...args],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
        let out = '';
        let err = '';
        run.stdout.on('data', chunk=>{
            out += chunk;
        });
        run.stderr.on('data', chunk=>{
            err += chunk;
        });
        run.on('error', reject);
        run.on('close', status=>{
            if (status !== 0)
            {
                reject(new Error(`the counted run of ${args.join(' ')} ended ${status}: `
                    + `${err.slice(-2000)}`));
                return;
            }
            const marks = [...err.matchAll(/^Mark : \d+ js (\d+) compile (\d+) gc (\d+) other (\d+)$/gm)]
                .map(([, ...counts])=>/** @type {Kinds} */ (Object.fromEntries(KINDS.map((kind, k)=>
                    [kind, Number(counts[k])]))));
            resolve({ marks, out });
        });
    });
}

/**
 * What ran between two marks.
 *
 * @param {Kinds[]} marks @param {number} from @param {number} to
 * @returns {Kinds}
 */
export const between = (marks, from, to)=>/** @type {Kinds} */ (Object.fromEntries(KINDS.map(
    kind=>[kind, marks[to][kind] - marks[from][kind]])));
