/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Redistributables made up for a test: a real installer database and
 * cabinets, built here, inside a program, as a bootstrapper carries them.
 */

import { buildCabinet } from '../layers/win32/cabinet/cabinet.fixture.js';
import { packageDatabase, typed } from '../layers/win32/msi/install.fixture.js';
import { databaseBytes } from '../layers/win32/msi/database-writer.js';

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, c=>c.charCodeAt(0));

/**
 * A stored cabinet of the files given, blocks of 32 KiB as the format caps them.
 *
 * @param {Record<string, Uint8Array>} files
 */
export function cabinet(files){
    const all = new Uint8Array(Object.values(files).reduce((sum, bytes)=>sum + bytes.length, 0));
    let at = 0;
    const entries = Object.entries(files).map(([name, bytes])=>{
        all.set(bytes, at);
        at += bytes.length;
        return { name, size: bytes.length, offset: at - bytes.length, folder: 0 };
    });
    const blocks = [];
    for (let from = 0; from < all.length; from += 32768)
    {
        const packed = all.subarray(from, from + 32768);
        blocks.push({ packed, size: packed.length });
    }
    return buildCabinet({ folders: [{ compression: 0, blocks }], files: entries });
}

/**
 * @typedef {Object} Shape
 * @property {boolean} wide  A 64-bit runtime.
 * @property {string} version
 * @property {number} size  Its runtime file's.
 * @property {number} [fill]  The runtime file's bytes.
 * @property {boolean} [tool]  A file outside the Windows folder too.
 */

/**
 * A Visual C++-shaped runtime package: the runtime in a merge module's folder
 * a custom action points at the 64-bit system folder (or the system folder),
 * the detection key, a file of a component whose condition is false and,
 * unless `tool` is false, one outside the Windows folder.
 *
 * @param {Shape} shape
 */
function runtimePackage({ wide, version, size, tool = true }){
    const folder = wide ? 'System64Folder' : 'SystemFolder';
    const key = `SOFTWARE\\VC\\Runtimes\\${wide ? 'x64' : 'x86'}`;
    return databaseBytes(typed(packageDatabase({
        Property: [['Property', 'Value'],
            [['ProductName', 'Runtime'], ['ProductVersion', version]]],
        Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
            ['TARGETDIR', null, 'SourceDir'],
            ['WinFolder_VC', 'TARGETDIR', 'Win'],
            ['SysFolder_VC', 'WinFolder_VC', 'Sys|System'],
            ['Program_VC', 'TARGETDIR', 'Prog'],
        ]],
        CustomAction: [['Action', 'Type', 'Source', 'Target'],
            [['SetSysFolder', 51, 'SysFolder_VC', `[${folder}]`]]],
        InstallExecuteSequence: [['Action', 'Condition', 'Sequence'],
            [['CostFinalize', null, 1000], ['SetSysFolder', null, 10]]],
        Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
            'KeyPath'], [
            ['C_runtime', '{1}', 'SysFolder_VC', wide ? 256 : 0, null, 'vcruntime140.dll'],
            ['C_old', '{2}', 'SysFolder_VC', 0, 'VersionNT = 501', 'ucrtbase.dll'],
            ['C_detect', '{3}', 'TARGETDIR', 4, null, 'reg1'],
            ...tool ? [['C_tool', '{4}', 'Program_VC', 0, null, 'tool.exe']] : [],
        ]],
        File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Sequence'], [
            ['vcruntime140.dll', 'C_runtime', 'vcrunt~1.dll|vcruntime140.dll', size, version, 1],
            ['ucrtbase.dll', 'C_old', 'ucrtbase.dll', 4, version, 2],
            ['tool.exe', 'C_tool', 'tool.exe', 3, version, 3],
        ]],
        Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'], [
            ['reg1', 2, key, 'Installed', '#1', 'C_detect'],
            ['reg2', 2, key, 'Version', '[ProductVersion]', 'C_detect'],
            ['reg3', 2, 'SOFTWARE\\Old', 'Here', '#1', 'C_old'],
        ]],
    })));
}

/**
 * A bootstrapper: a stub, then a cabinet holding the package and its own
 * cabinet of files -- as Burn appends its container after its engine.
 *
 * @param {Shape} shape
 */
export async function bootstrapper(shape){
    const files = cabinet({
        'vcruntime140.dll': new Uint8Array(shape.size).fill(shape.fill ?? 0),
        'ucrtbase.dll': latin1('ucrt'),
        'tool.exe': latin1('MZt'),
    });
    const container = cabinet({ a0: await runtimePackage(shape), a1: files });
    const program = new Uint8Array(4096 + container.length);
    program.set(latin1('MZ stub'), 0);
    program.set(container, 4096);
    return program;
}

/**
 * A program whose package installs outside the Windows folder: a game's own setup.
 */
export async function gameSetup(){
    const db = packageDatabase({
        Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
            ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
            ['Dir', 'ProgramFilesFolder', 'Game']]],
        Component: [['Component', 'Directory_', 'Attributes', 'Condition'],
            [['C', 'Dir', 0, null]]],
        File: [['File', 'Component_', 'FileName', 'FileSize'], [['f', 'C', 'f.txt', 1]]],
    });
    return cabinet({ 'p.msi': await databaseBytes(typed(db)), f: latin1('x') });
}
