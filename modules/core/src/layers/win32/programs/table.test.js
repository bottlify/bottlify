/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS_IN_PLACE, PROGRAMS_LIBRARY, SYSTEM_PROGRAMS, programInPlaceOf, systemProgramAt,
    systemProgramImage } from './table.js';
import { createProgramFunctions } from './functions.js';
import { parsePe, readImports } from '../../loader/internal/pe.js';
import { synthesiseProgram } from '../../loader/internal/synth.js';
import { rewriteResources } from '../kernel32/resource-update.js';

test('a program is one of the system folder\'s, however its path is spelled', ()=>{
    assert.equal(systemProgramAt('C:\\WINDOWS\\system32\\msiexec.exe'), 'msiexec');
    assert.equal(systemProgramAt('c:/windows//SYSTEM32/RunDll32.EXE'), 'rundll32');
    assert.equal(systemProgramAt(' C:\\Windows\\System32\\regsvr32.exe'), 'regsvr32');
    assert.equal(systemProgramAt('C:\\App\\msiexec.exe'), null, 'only there');
    assert.equal(systemProgramAt('C:\\WINDOWS\\system32\\sub\\msiexec.exe'), null);
    assert.equal(systemProgramAt('C:\\WINDOWS\\system32\\calc.exe'), null);
    assert.equal(systemProgramAt('msiexec.exe'), null, 'a bare name is the spawner\'s to find');
});

test('every program\'s image calls its own routine, and every routine is in the library', ()=>{
    const routines = Object.keys(createProgramFunctions(/** @type {any} */ ({})));
    for (const [name, { routine }] of SYSTEM_PROGRAMS)
    {
        const bytes = systemProgramImage(`C:\\WINDOWS\\system32\\${name}`);
        assert.ok(bytes, name);
        const imports = readImports(bytes, parsePe(bytes));
        assert.deepEqual(imports[0], { dll: PROGRAMS_LIBRARY,
            entries: [{ name: routine, ordinal: null, iatRva: imports[0].entries[0].iatRva }] });
        assert.ok(routines.includes(routine), `${PROGRAMS_LIBRARY} exports ${routine}`);
    }
    assert.equal(routines.length, SYSTEM_PROGRAMS.size + PROGRAMS_IN_PLACE.length,
        'and nothing else');
    assert.equal(systemProgramImage('C:\\App\\msiexec.exe'), null);
});

/**
 * A version block holding one string table of the given texts, laid out as
 * VerQueryValue reads one.
 *
 * @param {Record<string, string>} strings
 */
function versionBlock(strings){
    const utf16 = (/** @type {string} */ text)=>Uint8Array.from(
        [...`${text}\0`].flatMap(unit=>[unit.charCodeAt(0) & 0xff, unit.charCodeAt(0) >>> 8]));
    const pad = (/** @type {number} */ at)=>at + 3 & ~3;
    /** @param {string} key @param {Uint8Array | string | null} value @param {Uint8Array[]} [children] */
    const node = (key, value, children = [])=>{
        const bytes = typeof value === 'string' ? utf16(value) : value ?? new Uint8Array(0);
        const valueAt = pad(6 + (key.length + 1) * 2);
        let end = valueAt + bytes.length;
        const offsets = children.map(child=>{
            const at = pad(end);
            end = at + child.length;
            return at;
        });
        const out = new Uint8Array(end);
        const view = new DataView(out.buffer);
        view.setUint16(0, end, true);
        view.setUint16(2, typeof value === 'string' ? value.length + 1 : bytes.length, true);
        view.setUint16(4, typeof value === 'string' ? 1 : 0, true);
        out.set(utf16(key), 6);
        out.set(bytes, valueAt);
        children.forEach((child, index)=>out.set(child, offsets[index]));
        return out;
    };
    const fixed = new Uint8Array(52);
    new DataView(fixed.buffer).setUint32(0, 0xfeef04bd, true);
    return node('VS_VERSION_INFO', fixed, [node('StringFileInfo', null, [node('040904B0', null,
        Object.entries(strings).map(([key, text])=>node(key, text)))])]);
}

/** @param {Record<string, string>} strings */
const imageWith = strings=>{
    const file = rewriteResources(synthesiseProgram({ library: 'GAME.dll', routine: 'main' }).bytes,
        [{ type: 16, name: 1, language: 0x409, data: versionBlock(strings) }]);
    assert.ok(file instanceof Uint8Array, 'the image takes a resource section');
    return file;
};

test('DirectX\'s setup a title brings is run as the engine\'s own, known by its version', ()=>{
    // DXSETUP copied XP's DirectX over a system folder that lacked it and
    // answered "restart needed", which the game's installer stopped at.
    const bytes = programInPlaceOf(imageWith({ CompanyName: 'Microsoft Corporation',
        FileDescription: 'Microsoft DirectX Setup', OriginalFilename: 'DXSETUP.EXE' }));
    assert.ok(bytes, 'whatever the case of its name');
    const imports = readImports(bytes, parsePe(bytes));
    assert.equal(imports[0].dll, PROGRAMS_LIBRARY);
    assert.equal(imports[0].entries[0].name, 'dxsetup');

    assert.equal(programInPlaceOf(imageWith({ CompanyName: 'Electronic Arts',
        OriginalFilename: 'dxsetup.exe' })), null, 'only Microsoft\'s');
    assert.equal(programInPlaceOf(imageWith({ CompanyName: 'Microsoft Corporation',
        OriginalFilename: 'setup.exe' })), null, 'only that program');
    assert.equal(programInPlaceOf(synthesiseProgram({ library: 'GAME.dll', routine: 'main' })
        .bytes), null, 'an image with no version block');
    assert.equal(programInPlaceOf(new Uint8Array(64)), null, 'and bytes that are no image');
});

test('the setup run in DXSETUP\'s place succeeds without a restart, and shows nothing', async()=>{
    const functions = createProgramFunctions(/** @type {any} */ ({
        callerThread: ()=>null,
        answering: (/** @type {any} */ thread, /** @type {() => any} */ fn)=>fn(),
        allocate: ()=>0x1000,
        free: ()=>{},
        writeMemory: ()=>{},
        readWideString: ()=>'"D:\\DirectX\\DXSETUP.exe" /silent',
        /** @param {string} library */
        exports: library=>(library === 'KERNEL32.dll'
            ? { GetCommandLineW: { handler: ()=>0x2000 } } : {}),
    }));
    assert.equal(await functions.dxsetup.handler(), 0, 'DSETUPERR_SUCCESS: no restart');
});
