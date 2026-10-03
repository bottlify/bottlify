/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A modal Wizard97 property sheet, run as a program runs one: its pages are
 * the program's own templates and dialog procedure, its callback is the
 * program's, and every message the sheet sends a page, or sends itself, goes
 * into guest code on the thread that called PropertySheetA. Setting up the
 * first page sends the sheet its caption and then shows the page, and the
 * move to the second hides the first -- messages that each go into the
 * program one after another, never two at once.
 *
 * The callback posts Next and then Finish once the sheet is up; the program
 * exits with PropertySheetA's answer, and the count of pages its procedure
 * saw WM_INITDIALOG for above it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PSH_PROPSHEETPAGE = 0x0008;
const PSH_USECALLBACK = 0x0100;
const PSH_WIZARD97 = 0x01000000;
const PSP_DLGINDIRECT = 0x0001;
const PSCB_INITIALIZED = 1;
const PSM_PRESSBUTTON = 0x0471;
const PSBTN_NEXT = 1;
const PSBTN_FINISH = 2;
const WM_INITDIALOG = 0x0110;
const WS_CHILD = 0x40000000;
const WS_CAPTION = 0x00c00000;
const DS_SETFONT = 0x0040;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
/** @param {number} value @returns {number[]} */
const u16 = value=>[value & 0xff, (value >>> 8) & 0xff];
/** @param {string} text @returns {number[]} */
const wide = text=>[...text].flatMap(unit=>u16(unit.charCodeAt(0))).concat(0, 0);

/** An interior Wizard97 page's template, with a caption the sheet takes for its own. */
const TEMPLATE = [
    ...u32(WS_CHILD | WS_CAPTION | DS_SETFONT), ...u32(0),
    ...u16(0), ...u16(0), ...u16(0), ...u16(317), ...u16(143),
    ...u16(0), ...u16(0), ...wide('Welcome'),
    ...u16(8), ...wide('MS Shell Dlg'),
];

/** A PROPSHEETPAGEA of the first version, its template and procedure set by the code. */
const PAGE = [...u32(40), ...u32(PSP_DLGINDIRECT), ...new Array(32).fill(0)];

function buildWizardExe(){
    return buildExe({
        imports: {
            'COMCTL32.dll': ['PropertySheetA'],
            'USER32.dll': ['PostMessageA'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data: {
            // dwSize, dwFlags, hwndParent, hInstance, hIcon, pszCaption,
            // nPages, nStartPage; ppsp and pfnCallback are set by the code.
            header: [...u32(40), ...u32(PSH_PROPSHEETPAGE | PSH_USECALLBACK | PSH_WIZARD97),
                ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(2), ...u32(0),
                ...u32(0), ...u32(0)],
            pages: [...PAGE, ...PAGE],
            template: TEMPLATE,
            inits: [0, 0, 0, 0],
        },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {number} address @param {number} value */
            const store = (address, value)=>[0xc7, 0x05, ...u32(address), ...u32(value)];
            /** @param {number} callback @param {number} procedure */
            const main = (callback, procedure)=>[
                ...store(at('header') + 32, at('pages')),
                ...store(at('header') + 36, callback),
                ...store(at('pages') + 12, at('template')),
                ...store(at('pages') + 24, procedure),
                ...store(at('pages') + 40 + 12, at('template')),
                ...store(at('pages') + 40 + 24, procedure),
                0x68, ...u32(at('header')), //               push header
                0xff, 0x15, ...u32(iat('PropertySheetA')),
                0x8b, 0x1d, ...u32(at('inits')), //          mov ebx, [inits]
                0xc1, 0xe3, 0x04, //                         shl ebx, 4
                0x09, 0xd8, //                               or eax, ebx
                0x50, //                                     push eax
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            /** @param {number} button */
            const press = button=>[
                0x6a, 0x00, //                               push 0
                0x6a, button, //                             push button
                0x68, ...u32(PSM_PRESSBUTTON), //            push PSM_PRESSBUTTON
                0xff, 0x74, 0x24, 0x10, //                   push [esp+16]   hwnd
                0xff, 0x15, ...u32(iat('PostMessageA')),
            ];
            // PFNPROPSHEETCALLBACK(hwnd, message, lParam)
            const callback = [
                0x83, 0x7c, 0x24, 0x08, PSCB_INITIALIZED, // cmp dword [esp+8], PSCB_INITIALIZED
                0x75, 2 * press(0).length, //                jne out
                ...press(PSBTN_NEXT),
                ...press(PSBTN_FINISH),
                0x31, 0xc0, //                               out: xor eax, eax
                0xc2, 0x0c, 0x00, //                         ret 12
            ];
            // DLGPROC(hwnd, message, wParam, lParam): counts WM_INITDIALOG and
            // answers everything with FALSE, so every notification is 0.
            const procedure = [
                0x81, 0x7c, 0x24, 0x08, ...u32(WM_INITDIALOG), // cmp dword [esp+8], WM_INITDIALOG
                0x75, 0x06, //                               jne +6
                0xff, 0x05, ...u32(at('inits')), //          inc dword [inits]
                0x31, 0xc0, //                               xor eax, eax
                0xc2, 0x10, 0x00, //                         ret 16
            ];
            const length = main(0, 0).length;
            return [...main(code(length), code(length + callback.length)), ...callback,
                ...procedure];
        },
    });
}

test('a modal Wizard97 sheet of the program\'s pages comes up, turns to its second page and '
    + 'ends with Finish', { timeout: 60000 }, async t=>{
    const app = await createApp({
        executable: buildWizardExe(),
    });
    t.after(()=>app.dispose());

    assert.equal(await app.run({ timeoutMs: 30000 }), 1 | 2 << 4,
        'Finish answered 1, after both pages were made');
});
