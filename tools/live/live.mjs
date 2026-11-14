/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Everything that looks at a game while a person plays it, one command each:
 * every command attaches to the shared headed browser (CDP on 9333,
 * `CDP_PORT`; `CDP_PORT=driver` for the one `drive` keeps up) through
 * connect.mjs, reads the launcher tab and its workers, and never restarts or
 * resumes anything.
 *
 *   node tools/live/live.mjs help
 *   node tools/live/live.mjs <command> [args]
 *
 * A command is a module of commands/: one that exports `run(args)` is called
 * with its arguments; the others read them from their command line, which is
 * given to them as though they had been started alone.
 */

import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';

/**
 * The commands, in the order a hunt usually takes them: what the line says it
 * answers, and the module that answers it with the arguments put before the
 * user's (a mode of a command that has several).
 *
 * @type {Record<string, { what: string, usage: string, module: string,
 *     modes?: Record<string, string> }>}
 */
export const COMMANDS = {
    browser: { what: 'open the shared headed browser on the launcher, its profile kept',
        usage: '[url] [chrome flags]', module: 'browser.mjs' },
    drive: { what: 'a launcher tab of its own that takes orders over HTTP (shot, click, key, eval)',
        usage: '[card regex] [query]', module: 'drive.mjs' },
    eval: { what: 'the value of an expression in the launcher tab (`window.__bottlify__`)',
        usage: '"<expression>"', module: 'eval.mjs' },
    console: { what: "the page's console as it happens, WebGPU's errors included",
        usage: '[> dbg/console.log]', module: 'console.mjs' },
    watch: { what: 'a recorder left running; `--last N` folds the N seconds before "there"',
        usage: '[file] | --last SECONDS [file]', module: 'watch.mjs' },
    phases: { what: "the engine thread's phases and costliest host calls over the next N seconds",
        usage: '[seconds] [windows] [top]', module: 'phases.mjs' },
    diff: { what: 'what changed between two reports (host calls, frames, GPU time, pipelines)',
        usage: '[before.json] after.json [--top N]', module: 'diff.mjs' },
    profile: { what: "where a worker's time went: self, a function's callers, the dropped frames",
        usage: '[seconds] [worker] | --file F.cpuprofile [--callers RE | --drops F-frames.json]',
        module: 'profile.mjs' },
    memory: { what: 'is it climbing, who holds the big buffers, who allocates, why it collects',
        usage: 'watch | holders [minMB] [worker] | alloc [seconds] [top] | gc [seconds]',
        module: '', modes: { watch: 'memory-watch.mjs', holders: 'memory-holders.mjs',
            alloc: 'memory-alloc.mjs', gc: 'memory-gc.mjs' } },
    snapshot: { what: 'textures as the GPU holds them, as PNGs', usage: 't4414 t5 [--out DIR]',
        module: 'snapshot.mjs' },
    shader: { what: "a shader's bytecode beside every WGSL made of it", usage: 'ps585 [vs586]',
        module: 'shader.mjs' },
    cast: { what: 'every frame the tab composed, for a flicker a screenshot misses',
        usage: '[seconds] [dir]', module: 'cast.mjs' },
    audio: { what: 'sound: watch for faults, or record what the person hears',
        usage: 'watch | arm | save [seconds] [file]', module: '',
        modes: { watch: 'audio-watch.mjs', arm: 'audio-record.mjs', save: 'audio-record.mjs' } },
    bottle: { what: 'what an installation in the driven tab would put in its bottle',
        usage: '[depth] [port]', module: 'bottle.mjs' },
};

/** The help text: every command, one line each. */
export function help(){
    const width = Math.max(...Object.keys(COMMANDS).map(name=>name.length));
    return ['usage: node tools/live/live.mjs <command> [args]', '',
        ...Object.entries(COMMANDS).map(([name, { what, usage }])=>
            `  ${name.padEnd(width)}  ${what}\n  ${' '.repeat(width)}    ${usage}`)].join('\n');
}

/** Runs the command the command line names. */
async function main(){
    const [name, ...rest] = process.argv.slice(2);
    const command = name === undefined ? undefined : COMMANDS[name];
    if (!command)
    {
        console.log(help());
        process.exit(name === undefined || name === 'help' ? 0 : 2);
    }
    const mode = command.modes ? rest[0] : undefined;
    const file = !command.modes ? command.module
        : mode === undefined ? undefined : command.modes[mode];
    if (!file)
    {
        console.log(`usage: node tools/live/live.mjs ${name} ${command.usage}`);
        process.exit(2);
    }
    // A mode that is a command of its own (`arm`, `save`) is that module's first argument.
    const args = command.modes && mode !== 'arm' && mode !== 'save' ? rest.slice(1) : rest;
    const url = new URL(`commands/${file}`, import.meta.url);
    process.argv = [process.argv[0], fileURLToPath(url), ...args];
    const module = await import(url.href);
    if (typeof module.run === 'function')
    {
        await module.run(args);
        process.exit(0);
    }
}

if (isMain(import.meta.url))
{
    await main();
}
