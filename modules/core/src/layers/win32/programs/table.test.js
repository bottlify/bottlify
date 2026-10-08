/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAMS_LIBRARY, SYSTEM_PROGRAMS, systemProgramAt, systemProgramImage } from './table.js';
import { createProgramFunctions } from './functions.js';
import { parsePe, readImports } from '../../loader/internal/pe.js';

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
    assert.equal(routines.length, SYSTEM_PROGRAMS.size, 'and nothing else');
    assert.equal(systemProgramImage('C:\\App\\msiexec.exe'), null);
});
