#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator from a terminal: runs 32-bit x86 code with no operating
 * system under it, or writes what the translator makes of it as wasm.
 *
 *   cork run <file> [--at 0x1000] [--entry addr] [--ram MiB] [--max n]
 *       [--set eax=1,ecx=2] [--linux] [--config '<json>'] [--json]
 *   cork translate <file> [--at 0x1000] [--entry addr] [--precise] -o <out.wasm>
 *
 * <file> is a 32-bit little-endian ELF (its loadable segments at their
 * addresses, its entry) or flat code, loaded at `--at`. `run` ends at the
 * program's `hlt`, at a fault, at an `int n` or `out` it cannot answer, or
 * after `--max` instructions, and prints why, the registers and how much of the
 * run translated code ran. `--linux` answers `int 0x80` as Linux i386 does for
 * `exit` (1), `exit_group` (252) and `write` (4) to stdout and stderr, and
 * -ENOSYS for every other call. `--config` is the translator's (`EngineConfig`).
 *
 * `translate` forms one region at the entry and writes its module, which
 * imports the memory the state block is in and the runtime's helpers: to read
 * (wasm2wat, wasm-objdump), not to run alone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createMachine } from '../src/machine.js';
import { regionModule } from '../src/region-module.js';
import { parseElf32 } from '../src/elf.js';

const USAGE = `usage:
  cork run <file> [--at 0x1000] [--entry addr] [--ram MiB] [--max n]
      [--set eax=1,ecx=2] [--linux] [--config '<json>'] [--json]
  cork translate <file> [--at 0x1000] [--entry addr] [--precise] -o <out.wasm>`;

/** Linux i386's numbers for the calls `--linux` answers. */
const SYS_EXIT = 1;
const SYS_WRITE = 4;
const SYS_EXIT_GROUP = 252;
const ENOSYS = 38;

const MIB = 1 << 20;

/** @param {string[]} argv */
function parse(argv){
    /** @type {Record<string, string | true>} */
    const options = {};
    /** @type {string[]} */
    const positional = [];
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if (!arg.startsWith('-'))
        {
            positional.push(arg);
            continue;
        }
        const name = arg.replace(/^--?/, '');
        const next = argv[i + 1];
        if (['linux', 'json', 'precise', 'help', 'h'].includes(name) || next === undefined)
        {
            options[name] = true;
        }
        else
        {
            options[name] = next;
            i++;
        }
    }
    return { options, positional };
}

/** @param {string | true | undefined} value @param {number} fallback */
const number = (value, fallback)=>typeof value === 'string' ? Number(value) : fallback;

/**
 * The image's pieces and its entry: an ELF's segments, or the file at `at`.
 * @param {Uint8Array} file @param {number} at
 */
function imageOf(file, at){
    if (file[0] === 0x7f && file[1] === 0x45 && file[2] === 0x4c && file[3] === 0x46)
    {
        return parseElf32(file);
    }
    return { entry: at, segments: [{ address: at, bytes: file }] };
}

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/** @param {string} path @param {Record<string, string | true>} options */
async function run(path, options){
    const image = imageOf(readFileSync(path), number(options.at, 0x1000));
    const end = Math.max(...image.segments.map(({ address, bytes })=>address + bytes.length));
    // The image and a stack of a megabyte above it at least, in whole 64 KiB pages.
    const wanted = Math.max(number(options.ram, 16) * MIB, end + MIB);
    const ramSize = Math.ceil(wanted / 0x10000) * 0x10000;
    const config = typeof options.config === 'string' ? JSON.parse(options.config) : {};
    const machine = createMachine({ ramSize, config });
    for (const { address, bytes } of image.segments)
    {
        machine.load(address, bytes);
    }
    machine.setReg('esp', ramSize - 16);
    machine.setReg('eip', number(options.entry, image.entry));
    if (typeof options.set === 'string')
    {
        for (const pair of options.set.split(','))
        {
            const [name, value] = pair.split('=');
            machine.setReg(name.trim(), Number(value));
        }
    }
    const limit = number(options.max, Number.MAX_SAFE_INTEGER);
    const began = performance.now();
    let retired = 0;
    let translated = 0;
    /** @type {number | null} */
    let exitCode = null;
    /** @type {import('../src/machine.js').MachineStop} */
    let stop;
    for (;;)
    {
        stop = await machine.run({ maxInstructions: limit - retired });
        retired += stop.retired;
        translated += stop.translated;
        if (options.linux !== true || stop.reason !== 'interrupt' || stop.vector !== 0x80)
        {
            break;
        }
        const call = machine.reg('eax');
        if (call === SYS_EXIT || call === SYS_EXIT_GROUP)
        {
            exitCode = machine.reg('ebx') & 0xff;
            break;
        }
        if (call === SYS_WRITE && (machine.reg('ebx') === 1 || machine.reg('ebx') === 2))
        {
            const data = machine.read(machine.reg('ecx'), machine.reg('edx'));
            (machine.reg('ebx') === 1 ? process.stdout : process.stderr).write(data);
            machine.setReg('eax', data.length);
            continue;
        }
        machine.setReg('eax', -ENOSYS);
    }
    const seconds = (performance.now() - began) / 1000;
    const registers = Object.fromEntries(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
        'eip', 'eflags'].map(name=>[name, machine.reg(name)]));
    const report = {
        stop: exitCode !== null ? 'exit' : stop.reason,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(stop.vector !== undefined && exitCode === null ? { vector: stop.vector } : {}),
        ...(stop.value !== undefined ? { value: stop.value } : {}),
        ...(stop.op !== undefined ? { op: stop.op } : {}),
        retired, translated, seconds, registers,
    };
    await machine.dispose();
    if (options.json === true)
    {
        console.log(JSON.stringify(report));
    }
    else
    {
        const why = [report.stop, report.exitCode, report.vector, report.value, report.op]
            .filter(part=>part !== undefined).join(' ');
        console.error(`stopped: ${why} at ${hex(registers.eip)}`);
        console.error(Object.entries(registers).map(([name, value])=>`${name} ${hex(value)}`)
            .join('  '));
        console.error(`${retired} instructions, ${translated} of them translated,`
            + ` ${seconds.toFixed(3)} s`);
    }
    return exitCode ?? (report.stop === 'halt' ? 0 : 1);
}

/** @param {string} path @param {Record<string, string | true>} options */
function translate(path, options){
    const out = options.o ?? options.out;
    if (typeof out !== 'string')
    {
        throw new Error('translate: -o <out.wasm> is required');
    }
    const image = imageOf(readFileSync(path), number(options.at, 0x1000));
    const entry = number(options.entry, image.entry);
    const segment = image.segments.find(({ address, bytes })=>entry >= address
        && entry < address + bytes.length);
    if (segment === undefined)
    {
        throw new Error(`translate: no code at ${hex(entry)}`);
    }
    const module = regionModule({ code: segment.bytes, at: segment.address, entry,
        precise: options.precise === true });
    writeFileSync(out, module.wasm);
    console.error(`${out}: ${module.wasm.length} bytes, ${module.blocks.length} blocks,`
        + ` ${module.blocks.reduce((sum, block)=>sum + block.instructions, 0)} instructions`
        + ` over ${module.bytes} bytes from ${hex(module.entry)}`
        + (Object.keys(module.refused).length > 0
            ? `; refused ${JSON.stringify(module.refused)}` : ''));
    return 0;
}

const { options, positional } = parse(process.argv.slice(2));
const [command, path] = positional;
if (options.help === true || options.h === true || path === undefined
    || (command !== 'run' && command !== 'translate'))
{
    console.error(USAGE);
    process.exit(options.help === true || options.h === true ? 0 : 2);
}
try
{
    process.exitCode = command === 'run' ? await run(path, options) : translate(path, options);
}
catch (e){
    console.error(`cork: ${/** @type {Error} */ (e).message}`);
    process.exitCode = 2;
}
