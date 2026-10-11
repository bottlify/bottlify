/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * InstallShield 5's 16-bit setup launcher, done on the host.
 *
 * Some InstallShield 5 discs start from a `setup.exe` that is a 16-bit (NE)
 * program, which the engine cannot run. All the launcher does on a 32-bit
 * Windows is hand over to the 32-bit engine it carries in `_inst32i.ex_`, and
 * the 32-bit launcher of the same release does the same steps, which is how
 * they are known:
 *
 * 1. unpack every member of `_inst32i.ex_` (`stirling.js`) into
 *    `%TEMP%\_ISTMP1.DIR` under its second name -- the engine is the member
 *    named `INSTALL.EXE`;
 * 2. write the engine's command line into `_INS0432.INI` there:
 *    `-f<source>\SETUP.INS -z1 -cx -x<temp dir> -x1"<source>\" -q1<language>`,
 *    the language four hex digits from `setup.lid`;
 * 3. write the environment into `%WINDIR%\_isenv31.ini`, a block of
 *    `NAME=value` strings each ended by a NUL, the block by another;
 * 4. start the engine with no arguments -- it reads the two files.
 *
 * The launcher's own clean-up (`_ISDEL.EXE`, `_delis32.ini`) is left out:
 * the temporary directory is not part of what an install leaves in a bottle.
 */

import { readStirling } from './stirling.js';

const WINDOWS = 'C:\\WINDOWS';
const TEMP = `${WINDOWS}\\TEMP\\_ISTMP1.DIR`;
const ENGINE = 'install.exe';
const ENGINE_ARCHIVE = '_inst32i.ex_';
const DEFAULT_LANGUAGE = '0009';

/**
 * Whether an image is a 16-bit Windows program: an `MZ` header whose new
 * header is `NE`.
 * @param {Uint8Array} bytes
 */
export function isNeImage(bytes){
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    {
        return false;
    }
    const at = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x3c, true);
    return at + 2 <= bytes.length && bytes[at] === 0x4e && bytes[at + 1] === 0x45;
}

/**
 * The language `setup.lid` makes the default, as four hex digits.
 * @param {Uint8Array | undefined} lid
 */
function languageOf(lid){
    const text = lid ? String.fromCharCode(...lid) : '';
    const found = /^\s*Default\s*=\s*([0-9a-f]{1,4})\s*$/im.exec(text);
    return found ? found[1].padStart(4, '0').toLowerCase() : DEFAULT_LANGUAGE;
}

/**
 * @typedef {object} LauncherPlan
 * @property {string} imagePath  The engine, where the launcher puts it.
 * @property {Uint8Array} executable
 * @property {{ path: string, bytes: Uint8Array }[]} files  What the launcher
 *           writes before it starts the engine, absolute guest paths.
 */

/**
 * What the 16-bit launcher would leave and start, or null when the entry is
 * not one: a 16-bit image with `_inst32i.ex_` beside it.
 *
 * @param {Uint8Array} entry  The setup program's bytes.
 * @param {string} source  The directory it is started from, a guest path.
 * @param {{ name: string, bytes: Uint8Array }[]} beside  The files beside it.
 * @param {Record<string, string>} [environment]  The environment to hand on.
 * @returns {LauncherPlan | null}
 */
export function launcherPlan(entry, source, beside, environment = defaultEnvironment()){
    const named = (/** @type {string} */ name)=>beside.find(file=>file.name.toLowerCase() === name);
    const archive = named(ENGINE_ARCHIVE);
    if (!isNeImage(entry) || !archive)
    {
        return null;
    }
    const members = readStirling(archive.bytes);
    const engine = members.find(member=>member.name.toLowerCase() === ENGINE);
    if (!engine)
    {
        throw new Error(`${ENGINE_ARCHIVE} carries no ${ENGINE.toUpperCase()}`);
    }
    const from = source.replace(/\\+$/, '');
    const commandLine = `  -f${from}\\SETUP.INS  -z1 -cx -x${TEMP}  -x1"${from}\\"`
        + ` -q1${languageOf(named('setup.lid')?.bytes)}`;
    const block = Object.entries(environment)
        .map(([name, value])=>`${name}=${value}\0`).join('') + '\0';
    const latin1 = (/** @type {string} */ text)=>Uint8Array.from(text, c=>c.charCodeAt(0) & 0xff);
    return {
        imagePath: `${TEMP}\\${engine.stored}`,
        executable: engine.bytes,
        files: [
            ...members.map(member=>({ path: `${TEMP}\\${member.stored}`, bytes: member.bytes })),
            { path: `${TEMP}\\_INS0432.INI`, bytes: latin1(commandLine) },
            { path: `${WINDOWS}\\_isenv31.ini`, bytes: latin1(block) },
        ],
    };
}

/** The variables a launcher started from Explorer would have. */
function defaultEnvironment(){
    return {
        ALLUSERSPROFILE: 'C:\\Documents and Settings\\All Users',
        PATH: `${WINDOWS}\\system32;${WINDOWS}`,
        SystemRoot: WINDOWS,
        TEMP: `${WINDOWS}\\TEMP`,
        TMP: `${WINDOWS}\\TEMP`,
        windir: WINDOWS,
    };
}
