/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsLibraries } from './windows-libraries.mjs';

/** @param {string[]} names */
const configure = names=>names.map(name=>`WINE_CONFIG_MAKEFILE(dlls/${name})`).join('\n');

test('Windows\' own libraries are kept, with a .dll when they carry no extension', ()=>{
    assert.deepEqual(windowsLibraries(configure(['wlanapi', 'kernel32', 'ntoskrnl.exe', 'D3D9'])),
        ['d3d9.dll', 'kernel32.dll', 'ntoskrnl.exe', 'wlanapi.dll']);
});

test('what is Wine\'s alone is left out', ()=>{
    assert.deepEqual(windowsLibraries(configure(['winex11.drv', 'wineps.drv', 'stdole2.tlb',
        'krnl386.exe16', 'vdmdbg', 'nsiproxy.sys', 'comctl32_v6', 'twaindsm'])), ['vdmdbg.dll']);
});

test('a runtime a program brings is left out, the ones Windows ships kept', ()=>{
    assert.deepEqual(windowsLibraries(configure(['msvcr100', 'msvcp140', 'msvcp60', 'msvcrt',
        'd3dx9_43', 'd3dcompiler_43', 'd3dcompiler_47', 'xinput1_3', 'xinput1_4', 'xaudio2_7',
        'xaudio2_9', 'mfc140u', 'mfc42u', 'vcruntime140', 'ucrtbase'])),
    ['d3dcompiler_47.dll', 'mfc42u.dll', 'msvcp60.dll', 'msvcrt.dll', 'ucrtbase.dll',
        'xaudio2_9.dll', 'xinput1_4.dll']);
});
