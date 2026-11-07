/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectX's redistributable setup (`DXSETUP.exe`), run by the engine in place
 * of the copy a title brings.
 *
 * DirectX itself is the drawing layer's, so the system's own DirectX that a
 * redistributable carries for older systems is left alone, as the setup leaves
 * it on XP and later. What it does install is its optional components - D3DX
 * 9, 10 and 11, the shader compilers, XAudio2, XACT - each a cabinet beside it
 * (`Jun2010_d3dx10_43_x86.cab`) with the INF it is installed by, and those are
 * put where their INFs say, as a Steam bottle's install puts them
 * (`dsetup/redistributable.js`). No window is shown and no restart is asked.
 *
 * Everything goes through this process's own exports - FindFirstFileW,
 * CreateFileW, ReadFile, WriteFile - like any other program's file work.
 */

import { DIRECTX_CABINET, directxFiles } from '../dsetup/redistributable.js';

const MAX_PATH = 260;
const INVALID_HANDLE_VALUE = 0xffffffff;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const MEM_COMMIT_RESERVE = 0x3000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 4;
const PROCESSOR_ARCHITECTURE_AMD64 = 9;

/** WIN32_FIND_DATAW: its size, nFileSizeLow's offset and cFileName's. */
const FIND_DATA_SIZE = 592;
const FIND_SIZE_LOW = 32;
const FIND_NAME = 44;

/**
 * DXSETUP's exit codes, dsetup.h's DSETUPERR_*: succeeded with no restart, a
 * cabinet that could not be read, a file that could not be written.
 */
export const DXSETUP_SUCCESS = 0;
export const DSETUPERR_SOURCEFILENOTFOUND = -2;
export const DSETUPERR_NOCOPY = -5;

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
 * @param {import('./msiexec.js').ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runDxsetup(context){
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>context.call('KERNEL32.dll', name, args);
    const u32 = (/** @type {number} */ at)=>new DataView(context.read(at, 4).buffer)
        .getUint32(0, true);

    const modulePath = context.block(MAX_PATH * 2);
    const length = await kernel32('GetModuleFileNameW', [0, modulePath, MAX_PATH]);
    const self = wideText(context.read(modulePath, length * 2 + 2));
    const folder = self.slice(0, self.lastIndexOf('\\') + 1);

    const info = context.block(36);
    await kernel32('GetNativeSystemInfo', [info]);
    const architecture = context.read(info, 2);
    const machine = (architecture[0] | architecture[1] << 8) === PROCESSOR_ARCHITECTURE_AMD64
        ? 'amd64' : 'x86';

    /** @type {{ name: string, size: number }[]} */
    const found = [];
    const data = context.block(FIND_DATA_SIZE);
    const search = await kernel32('FindFirstFileW', [context.wide(`${folder}*.cab`), data]);
    for (let more = search !== INVALID_HANDLE_VALUE; more;
        more = await kernel32('FindNextFileW', [search, data]) !== 0)
    {
        const record = context.read(data, FIND_DATA_SIZE);
        const name = wideText(record.subarray(FIND_NAME));
        if (DIRECTX_CABINET.test(name))
        {
            found.push({ name,
                size: new DataView(record.buffer).getUint32(FIND_SIZE_LOW, true) });
        }
    }
    if (search !== INVALID_HANDLE_VALUE)
    {
        await kernel32('FindClose', [search]);
    }

    const done = context.block(4);
    let answer = DXSETUP_SUCCESS;
    /** @type {Uint8Array[]} */
    const cabinets = [];
    for (const { name, size } of found)
    {
        const file = await kernel32('CreateFileW', [context.wide(`${folder}${name}`),
            GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0]);
        if (file === INVALID_HANDLE_VALUE)
        {
            answer = DSETUPERR_SOURCEFILENOTFOUND;
            continue;
        }
        const buffer = await kernel32('VirtualAlloc', [0, size, MEM_COMMIT_RESERVE,
            PAGE_READWRITE]);
        if (await kernel32('ReadFile', [file, buffer, size, done, 0]))
        {
            cabinets.push(context.read(buffer, u32(done)));
        }
        else
        {
            answer = DSETUPERR_SOURCEFILENOTFOUND;
        }
        await kernel32('VirtualFree', [buffer, 0, MEM_RELEASE]);
        await kernel32('CloseHandle', [file]);
    }

    for (const { path, bytes } of directxFiles(cabinets, machine).files)
    {
        // A folder below the system's, where an INF names one, made first.
        const parts = path.split('\\');
        for (let depth = 3; depth < parts.length; depth++)
        {
            await kernel32('CreateDirectoryW', [context.wide(parts.slice(0, depth).join('\\')), 0]);
        }
        const file = await kernel32('CreateFileW', [context.wide(path), GENERIC_WRITE, 0, 0,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0]);
        if (file === INVALID_HANDLE_VALUE)
        {
            answer = DSETUPERR_NOCOPY;
            continue;
        }
        const buffer = await kernel32('VirtualAlloc', [0, bytes.length || 1, MEM_COMMIT_RESERVE,
            PAGE_READWRITE]);
        context.write(buffer, bytes);
        if (!await kernel32('WriteFile', [file, buffer, bytes.length, done, 0])
            || u32(done) !== bytes.length)
        {
            answer = DSETUPERR_NOCOPY;
        }
        await kernel32('VirtualFree', [buffer, 0, MEM_RELEASE]);
        await kernel32('CloseHandle', [file]);
    }
    return answer;
}
