/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The RunOnce pass of a logon: what Explorer does with
 * `Software\Microsoft\Windows\CurrentVersion\RunOnce` under HKEY_LOCAL_MACHINE
 * and then HKEY_CURRENT_USER before the desktop is anyone's.
 *
 * Each value is a command line, run one after another by the order of the
 * values' names, each waited for. A value is deleted before its command runs,
 * so a command that fails is not run again at the next logon; one whose name
 * starts with `!` is deleted only after its command succeeded. A session here
 * is a logon: the pass runs once, on the first process's thread before the
 * program's first instruction (`synthesiseProcessInit`'s prelude).
 *
 * The commands are run by the system programs this engine provides
 * (`table.js`) - regsvr32 above all, which an installation that could not
 * run a library's own registration leaves here - in this process and on this
 * thread, each with its own command line; a command naming any other program
 * is not run, said (decisions.md, the RunOnce pass).
 */

import { SYSTEM_PROGRAMS } from './table.js';
import { argumentsOf, splitArguments } from './command-line.js';
import { parseRegsvr32 } from './regsvr32.js';

/** The key, below either root. */
export const RUN_ONCE_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';

const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
/** KEY_QUERY_VALUE | KEY_SET_VALUE: values read and deleted. */
const KEY_QUERY_AND_SET = 0x1 | 0x2;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const ERROR_SUCCESS = 0;
/** Longest value name RegEnumValue hands, in characters, and the data read of one. */
const NAME_CHARS = 16384;
const DATA_BYTES = 0x10000;

/** @param {number} value */
const dword = value=>new Uint8Array(new Uint32Array([value]).buffer);

/** @param {Uint8Array} bytes  UTF-16, up to its terminator. */
const wideText = bytes=>{
    let text = '';
    for (let at = 0; at + 1 < bytes.length; at += 2)
    {
        const code = bytes[at] | bytes[at + 1] << 8;
        if (code === 0)
        {
            break;
        }
        text += String.fromCharCode(code);
    }
    return text;
};

/**
 * @param {import('./msiexec.js').ProgramContext} context  The calling thread's,
 *        its command line the process's.
 * @param {(commandLine: string) => import('./msiexec.js').ProgramContext} contextFor
 *        The same thread's context for a program run with that command line.
 * @param {(api: string, detail: string) => void} divergence
 * @returns {Promise<number>} how many commands ran
 */
export async function runOnceAtLogon(context, contextFor, divergence){
    /** @param {string} name @param {number[]} args */
    const advapi32 = (name, args)=>context.call('ADVAPI32.dll', name, args);
    const u32 = (/** @type {number} */ at)=>new DataView(context.read(at, 4).buffer)
        .getUint32(0, true);
    let ran = 0;
    for (const root of [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER])
    {
        const opened = context.block(8);
        if (await advapi32('RegOpenKeyExW', [root, context.wide(RUN_ONCE_KEY), 0,
            KEY_QUERY_AND_SET, opened]) !== ERROR_SUCCESS)
        {
            continue;
        }
        const key = u32(opened);
        /** @type {{ name: string, command: string }[]} */
        const values = [];
        const name = context.block(NAME_CHARS * 2);
        const data = context.block(DATA_BYTES);
        const nameLength = context.block(4);
        const type = context.block(4);
        const dataLength = context.block(4);
        for (let index = 0; ; index++)
        {
            context.write(nameLength, dword(NAME_CHARS));
            context.write(dataLength, dword(DATA_BYTES));
            if (await advapi32('RegEnumValueW', [key, index, name, nameLength, 0, type, data,
                dataLength]) !== ERROR_SUCCESS)
            {
                break;
            }
            if (u32(type) === REG_SZ || u32(type) === REG_EXPAND_SZ)
            {
                values.push({ name: wideText(context.read(name, u32(nameLength) * 2 + 2)),
                    command: wideText(context.read(data, u32(dataLength))) });
            }
        }
        values.sort((a, b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        for (const { name: value, command } of values)
        {
            const program = programOf(command);
            // Windows' 64-bit regsvr32 starts the 32-bit one for a 32-bit
            // library; here the command runs in this process, which loads only
            // its own width. The value stays for a session whose first process
            // has the library's: one never run is not lost.
            const library = program?.routine === 'regsvr32'
                ? parseRegsvr32(argumentsOf(command)).libraries[0] : undefined;
            if (library !== undefined && await otherWidth(context, library))
            {
                divergence('RunOnce', `${command}: a library of the other width, kept for a`
                    + ' session of its width');
                continue;
            }
            const later = value.startsWith('!');
            const remove = ()=>advapi32('RegDeleteValueW', [key, context.wide(value)]);
            if (!later)
            {
                await remove();
            }
            if (!program)
            {
                divergence('RunOnce', `${command}: not a program this engine runs at logon;`
                    + ' not run');
                continue;
            }
            const code = await program.run(contextFor(command));
            ran++;
            if (code !== 0)
            {
                divergence('RunOnce', `${command} exited with ${code}`);
            }
            else if (later)
            {
                await remove();
            }
        }
        await advapi32('RegCloseKey', [key]);
    }
    return ran;
}

/** IMAGE_FILE_HEADER.Machine of a PE image's headers, or 0. @param {Uint8Array} head */
function machineOf(head){
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 0x40 || view.getUint16(0, true) !== 0x5a4d)
    {
        return 0;
    }
    const at = view.getUint32(0x3c, true);
    return at + 6 <= head.length && view.getUint32(at, true) === 0x4550
        ? view.getUint16(at + 4, true) : 0;
}

/**
 * Whether a library's image is of the other width than this process's: its
 * file's machine read through the process's own calls, and the program's
 * image's in memory. A file that cannot be read is not of the other width,
 * and the command runs and says why it failed.
 *
 * @param {import('./msiexec.js').ProgramContext} context
 * @param {string} path
 */
async function otherWidth(context, path){
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    const HEAD = 0x400;
    const file = await kernel32('CreateFileW', [context.wide(path), 0x80000000, 1, 0, 3, 0, 0]);
    if ((file >>> 0) === 0xffffffff || file === 0)
    {
        return false;
    }
    const buffer = context.block(HEAD);
    const read = context.block(4);
    await kernel32('ReadFile', [file, buffer, HEAD, read, 0]);
    await kernel32('CloseHandle', [file]);
    const library = machineOf(context.read(buffer, HEAD));
    const image = await kernel32('GetModuleHandleW', [0]);
    const own = image ? machineOf(context.read(image, HEAD)) : 0;
    return library !== 0 && own !== 0 && library !== own;
}

/**
 * The system program a command line starts, by its argv[0]'s file name, with
 * or without `.exe` and wherever its path says it is.
 *
 * @param {string} command
 */
function programOf(command){
    const first = splitArguments(command)[0]?.text ?? '';
    const file = first.slice(Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/')) + 1)
        .toLowerCase();
    return SYSTEM_PROGRAMS.get(file.endsWith('.exe') ? file : `${file}.exe`) ?? null;
}
