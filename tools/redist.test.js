/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * tools/redist.mjs: which shared depots an install takes, what a Steam install
 * script asks for, and a redistributable's packages applied to a bottle -- a
 * real installer database and cabinets, built here, inside a program, as a
 * bootstrapper carries them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCabinet } from '../modules/core/src/layers/win32/cabinet/cabinet.fixture.js';
import { packageDatabase, typed } from '../modules/core/src/layers/win32/msi/install.fixture.js';
import { databaseBytes } from '../modules/core/src/layers/win32/msi/database-writer.js';
import {
    applyPackage, compareVersions, depotOwners, imageMachine, installRedistributables,
    parseInstallScript, registryValue, sharedDepots, unpackRedistributable, wantedDepot,
    writeRegistry,
} from './redist.mjs';

const HKLM = 0x80000002;
const HKCU = 0x80000001;

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, c=>c.charCodeAt(0));

test('an install takes the depots of other apps the app names, at their owners\' manifests',
    ()=>{
        const shared = (/** @type {any} */ config)=>({ config, depotfromapp: '228980' });
        const info = { depots: {
            228986: { ...shared({ oslist: 'windows' }), sharedinstall: '1' },
            228990: shared({ oslist: 'windows' }),
            228999: shared({ oslist: 'macos' }),
            228998: shared({ oslist: 'windows', language: 'german' }),
            228997: shared(undefined),
            361422: { config: { oslist: 'windows' }, manifests: { public: { gid: '5' } } },
            branches: { public: { buildid: '1' } },
        } };
        const gid = (/** @type {string} */ value)=>({ manifests: { public: { gid: value } } });
        const owner = { depots: { 228986: gid('8782296191957114623'),
            228990: gid('1829726630299308803'), 228999: gid('3'), 228998: gid('4') } };
        assert.deepEqual(depotOwners(info), [228980]);
        assert.deepEqual(sharedDepots(info, new Map([[228980, owner]])), [
            { id: 228986, app: 228980, gid: 8782296191957114623n },
            { id: 228990, app: 228980, gid: 1829726630299308803n },
        ], 'Windows\' and the language\'s; one the owner has no manifest for is not');
        assert.deepEqual(sharedDepots(info, new Map()), [], 'no owner\'s info, none');
        assert.equal(wantedDepot({ config: { oslist: 'windows' }, dlcappid: '9' }, 'english'),
            false);
        assert.equal(wantedDepot({}, 'english'), true);
    });

test('an install script: its registry values and the programs it runs', ()=>{
    const script = parseInstallScript(String.raw`"Installscript"
{
    "Registry"
    {
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor\\Game"
        {
            "string" { "InstDir" "%INSTALLDIR%" }
            "dword" { "Installed" "1" }
        }
        "HKEY_CURRENT_USER\\Software\\Vendor" { "string" { "Language" "1033" } }
    }
    "Run Process"
    {
        "VCRedist"
        {
            "process 1" "%INSTALLDIR%\\redist\\vc_redist.x86.exe"
            "Command 1" "/q"
            "Process 2" "%INSTALLDIR%\\redist\\vc_redist.x64.exe"
            "Requirement_OS" { "Is64BitWindows" "1" }
        }
    }
}
"kvsignatures" { "Installscript" "00" }`);
    assert.deepEqual(script.registry.map(({ root, key, name, type })=>({ root, key, name, type })),
        [
            { root: HKLM, key: 'SOFTWARE\\Vendor\\Game', name: 'InstDir', type: 1 },
            { root: HKLM, key: 'SOFTWARE\\Vendor\\Game', name: 'Installed', type: 4 },
            { root: HKCU, key: 'Software\\Vendor', name: 'Language', type: 1 },
        ]);
    assert.deepEqual(script.registry[0].data, latin1('C:\\App\0'), '%INSTALLDIR% is the bottle\'s');
    assert.deepEqual([...script.registry[1].data], [1, 0, 0, 0]);
    assert.deepEqual(script.runs, [{ name: 'VCRedist', requires64: true, programs: [
        { path: 'C:\\App\\redist\\vc_redist.x86.exe', arguments: '/q' },
        { path: 'C:\\App\\redist\\vc_redist.x64.exe', arguments: '' },
    ] }]);
});

test('a Registry table\'s values are typed by their prefixes; versions compare by field', ()=>{
    assert.deepEqual(registryValue('#14'), { type: 4, data: Uint8Array.of(14, 0, 0, 0) });
    assert.deepEqual(registryValue('#x0aff'), { type: 3, data: Uint8Array.of(10, 255) });
    assert.equal(registryValue('#%%SystemRoot%').type, 2);
    assert.deepEqual(registryValue('##1'), { type: 1, data: latin1('#1\0') });
    assert.deepEqual(registryValue('a[~]b'), { type: 7, data: latin1('a\0b\0\0') });
    assert.equal(registryValue('v14.0').type, 1);
    assert.ok(compareVersions('14.24.28127.4', '14.0.24215.1') > 0);
    assert.equal(compareVersions('9.0', '9.0.0'), 0);
});

test('registry writes go into a hive\'s JSON, a later value of a name over an earlier', ()=>{
    const hive = writeRegistry(null, [
        { root: HKLM, key: 'SOFTWARE\\A\\B', name: 'X', type: 4, data: Uint8Array.of(1, 0, 0, 0) },
        { root: HKLM, key: 'software\\a\\b', name: 'x', type: 4, data: Uint8Array.of(2, 0, 0, 0) },
    ]);
    const leaf = { name: 'B', keys: [], values: [{ name: 'x', type: 4, data: [2, 0, 0, 0] }] };
    assert.deepEqual(hive, { roots: [{ id: HKLM, key: { name: '', values: [], keys: [
        { name: 'SOFTWARE', values: [], keys: [{ name: 'A', values: [], keys: [leaf] }] }] } }] });
});

test('a PE image says its machine', ()=>{
    const image = new Uint8Array(0x100);
    const view = new DataView(image.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint16(0x84, 0x8664, true);
    assert.equal(imageMachine(image), 'amd64');
    view.setUint16(0x84, 0x14c, true);
    assert.equal(imageMachine(image), 'x86');
});

/**
 * A stored cabinet of the files given, blocks of 32 KiB as the format caps them.
 *
 * @param {Record<string, Uint8Array>} files
 */
function cabinet(files){
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
async function bootstrapper(shape){
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

test('a bootstrapper\'s package is applied by its tables on the machine it is for', async()=>{
    const program = await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 0x64 });
    const { packages, files } = await unpackRedistributable(program);
    assert.equal(packages.length, 1, 'the package inside the container inside the program');

    const wide = applyPackage(packages[0], files, 'amd64');
    assert.deepEqual(wide.files.map(file=>[file.path, file.bytes.length, file.bytes[0]]),
        [['C:\\WINDOWS\\system32\\vcruntime140.dll', 40, 0x64]],
        'its folder set by the custom action; the false condition\'s file left out');
    assert.deepEqual(wide.registry.map(({ key, name, data })=>[key, name, [...data]]), [
        ['SOFTWARE\\VC\\Runtimes\\x64', 'Installed', [1, 0, 0, 0]],
        ['SOFTWARE\\VC\\Runtimes\\x64', 'Version', [...latin1('14.0.1\0')]],
    ], 'the detection component\'s rows, the property read');
    assert.deepEqual(wide.skipped, ['tool.exe: its directory is not a Windows folder']);

    assert.deepEqual(applyPackage(packages[0], files, 'x86').files, [],
        'a 64-bit component is no 32-bit machine\'s');
    const narrow = await unpackRedistributable(
        await bootstrapper({ wide: false, version: '14.0.1', size: 30 }));
    assert.deepEqual(applyPackage(narrow.packages[0], narrow.files, 'amd64').files
        .map(file=>file.path), ['C:\\WINDOWS\\SysWOW64\\vcruntime140.dll'],
    'a 32-bit runtime on a 64-bit machine is in SysWOW64');
    assert.deepEqual(applyPackage(narrow.packages[0], narrow.files, 'x86').files
        .map(file=>file.path), ['C:\\WINDOWS\\system32\\vcruntime140.dll']);
});

test('two files of one key in a bootstrapper: the package takes the one of its size', async()=>{
    const x86 = cabinet({ 'vcruntime140.dll': new Uint8Array(30).fill(0x32) });
    const program = await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 0x64 });
    const both = new Uint8Array(2 + x86.length + program.length);
    both.set(latin1('MZ'), 0);
    both.set(x86, 2);
    both.set(program, 2 + x86.length);
    const { packages, files } = await unpackRedistributable(both);
    assert.equal(files.get('vcruntime140.dll')?.length, 2);
    assert.equal(applyPackage(packages[0], files, 'amd64').files[0].bytes[0], 0x64);
});

/**
 * A program whose package installs outside the Windows folder: a game's own setup.
 */
async function gameSetup(){
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

test('an app\'s install scripts and the runtimes it carries are installed into its bottle',
    async()=>{
        const app = await mkdtemp(join(tmpdir(), 'redist-'));
        try
        {
            const vc = join(app, '_CommonRedist', 'vc');
            await mkdir(vc, { recursive: true });
            await mkdir(join(app, 'Engine', 'Prereq'), { recursive: true });
            await writeFile(join(vc, 'vc_redist.x64.exe'),
                await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 1 }));
            await writeFile(join(vc, 'install x64.cmd'),
                '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x64" /q /norestart\r\n');
            await writeFile(join(vc, 'installscript.vdf'), String.raw`"InstallScript"
{ "Run Process" {
  "x64" { "process 1" "%INSTALLDIR%\\_CommonRedist\\vc\\install x64.cmd" }
  "missing" { "process 1" "%INSTALLDIR%\\_CommonRedist\\vc\\gone.exe" }
} }`);
            await writeFile(join(app, 'game.vdf'), String.raw`"InstallScript"
{ "Registry" { "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor" { "string" { "Dir" "%INSTALLDIR%" } } } }`);
            // The app's own prerequisite installer: a newer runtime, applied over the older.
            await writeFile(join(app, 'Engine', 'Prereq', 'Prereq.exe'), await bootstrapper(
                { wide: true, version: '14.24.2', size: 44, fill: 2, tool: false }));
            await writeFile(join(app, 'Setup.exe'), await gameSetup());

            const said = await installRedistributables(app,
                ['_CommonRedist\\vc\\installscript.vdf', 'game.vdf'], 'amd64');
            assert.deepEqual(said, [
                '_CommonRedist\\vc\\installscript.vdf: missing: '
                    + 'C:\\App\\_CommonRedist\\vc\\gone.exe is not in the app',
                '_CommonRedist\\vc\\vc_redist.x64.exe: 1 package(s), 1 file(s)',
                'Engine\\Prereq\\Prereq.exe: 1 package(s), 1 file(s), the app\'s own',
                'redistributables: 1 file(s), 5 registry value(s)',
            ], 'the batch file\'s program run; a setup installing elsewhere not');
            const runtime = await readFile(
                join(app, '.bottlify', 'drive_c', 'WINDOWS', 'system32', 'vcruntime140.dll'));
            assert.deepEqual([runtime.length, runtime[0]], [44, 2], 'the newer runtime\'s file');
            const hive = JSON.parse(
                await readFile(join(app, '.bottlify', 'registry.json'), 'utf8'));
            /** @param {string} path @param {string} name */
            const value = (path, name)=>path.split('\\').reduce((key, part)=>key.keys
                .find((/** @type {any} */ one)=>one.name === part), hive.roots
                .find((/** @type {any} */ root)=>root.id === HKLM).key)
                .values.find((/** @type {any} */ one)=>one.name === name).data;
            assert.deepEqual(value('SOFTWARE\\VC\\Runtimes\\x64', 'Version'),
                [...latin1('14.24.2\0')], 'and its registry values');
            assert.deepEqual(value('SOFTWARE\\Vendor', 'Dir'), [...latin1('C:\\App\0')]);
            assert.equal(existsSync(join(app, '.bottlify', 'drive_c', 'Program Files')), false);

            // A 32-bit machine has no 64-bit runtime: the scripts' registry alone.
            await rm(join(app, '.bottlify'), { recursive: true });
            const narrow = await installRedistributables(app, ['game.vdf'], 'x86');
            assert.equal(narrow.at(-1), 'redistributables: 0 file(s), 1 registry value(s)');
        }
        finally
        {
            await rm(app, { recursive: true, force: true });
        }
    });
