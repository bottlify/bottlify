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
import { splitArguments } from './command-line.js';

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
            const later = value.startsWith('!');
            const remove = ()=>advapi32('RegDeleteValueW', [key, context.wide(value)]);
            if (!later)
            {
                await remove();
            }
            const program = programOf(command);
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
