/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * oledlg - the OLE user interface library: the standard dialogs for inserting,
 * linking, converting and pasting embedded objects, and the verb menu of a
 * selected object. A program built on MFC imports it through MFC's own
 * library whether or not it embeds anything, so without it such a program
 * does not load at all.
 *
 * None of its dialogs is shown here. Each validates its structure the way
 * the library does - no structure, or one whose size is not the size it
 * declares, is refused with the error a caller checks - and then answers as
 * if the user had pressed Cancel, which every caller has to handle; that the
 * dialog was not shown is said as a loss. The verb menu is built as the
 * library builds it for no object: a greyed "&Object" item.
 */

/** OLEUI_* answers (oledlg.h). */
const OLEUI_FALSE = 0;
const OLEUI_CANCEL = 2;
const OLEUI_ERR_STRUCTURENULL = 101;
const OLEUI_ERR_CBSTRUCTINCORRECT = 103;

/** The item the verb menu holds for no object. */
const OBJECT_ITEM = '&Object';

/**
 * Text as a null-terminated string of the width asked: ANSI bytes, or UTF-16.
 *
 * @param {string} text @param {0 | 1} wide
 */
const textOf = (text, wide)=>{
    const units = [...text, '\0'].map(c=>c.charCodeAt(0));
    return wide ? new Uint8Array(Uint16Array.from(units).buffer) : Uint8Array.from(units);
};

/** IDCANCEL, what OleUIPromptUser answers for a prompt nobody saw. */
const IDCANCEL = 2;

/** Menu flags (winuser.h). */
const MF_BYPOSITION = 0x400;
const MF_GRAYED = 0x1;
const MF_STRING = 0;

/**
 * Each dialog's structure, by the size its first member must hold for the
 * width of the caller: cbStruct comes first in every one of them, so a size
 * other than the structure's is the caller's mistake, not a newer revision.
 * The sizes are sizeof of the A and W structures of the SDK's oledlg.h, as
 * a compiler for i386 and for x86-64 lays them out.
 *
 * @type {Record<string, { 4: [number, number], 8: [number, number] }>}  [A, W] sizes
 */
const STRUCTURE_SIZES = {
    InsertObject: { 4: [112, 112], 8: [176, 176] },
    PasteSpecial: { 4: [84, 84], 8: [136, 136] },
    EditLinks: { 4: [40, 40], 8: [72, 72] },
    ChangeIcon: { 4: [320, 580], 8: [352, 616] },
    Convert: { 4: [136, 136], 8: [192, 192] },
    Busy: { 4: [44, 44], 8: [80, 80] },
    ObjectProperties: { 4: [40, 40], 8: [72, 72] },
    ChangeSource: { 4: [80, 80], 8: [136, 136] },
};

/**
 * @typedef {Object} OledlgHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {4 | 8} [pointerSize]
 * @property {() => Record<string, any>} user32  USER32's table, whose menu calls build the
 *           verb menu: asked for at the call, as it is made after this one.
 * @property {(bytes: Uint8Array, use: (address: number) => any) => any} lent
 *           Bytes put in guest memory for as long as `use` runs.
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * The export numbers oledlg.dll has, by which MFC's library imports it.
 */
export const OLEDLG_ORDINALS = Object.freeze({
    1: 'OleUIAddVerbMenuA', 2: 'OleUICanConvertOrActivateAs', 3: 'OleUIInsertObjectA',
    4: 'OleUIPasteSpecialA', 5: 'OleUIEditLinksA', 6: 'OleUIChangeIconA', 7: 'OleUIConvertA',
    8: 'OleUIBusyA', 9: 'OleUIUpdateLinksA', 10: 'OleUIPromptUserA',
    11: 'OleUIObjectPropertiesA', 12: 'OleUIChangeSourceA', 13: 'OleUIPromptUserW',
    14: 'OleUIAddVerbMenuW', 15: 'OleUIBusyW', 16: 'OleUIChangeIconW', 17: 'OleUIChangeSourceW',
    18: 'OleUIConvertW', 19: 'OleUIEditLinksW', 20: 'OleUIInsertObjectW',
    21: 'OleUIObjectPropertiesW', 22: 'OleUIPasteSpecialW', 23: 'OleUIUpdateLinksW',
});

/**
 * @param {OledlgHost} host
 * @returns {Record<string, any>}
 */
export function createOledlgFunctions(host){
    const pointer = host.pointerSize ?? 4;

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(wholeAddress(address), 4).slice().buffer)
        .getUint32(0, true);

    /**
     * A dialog's entry: its structure checked, then Cancel, the dialog not shown.
     *
     * @param {string} name @param {0 | 1} wide
     */
    const dialog = (name, wide)=>{
        const api = `OleUI${name}${wide ? 'W' : 'A'}`;
        const size = STRUCTURE_SIZES[name][pointer][wide];
        return {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([structure])=>{
                if ((structure >>> 0) === 0)
                {
                    return OLEUI_ERR_STRUCTURENULL;
                }
                if (readU32(structure) !== size)
                {
                    return OLEUI_ERR_CBSTRUCTINCORRECT;
                }
                host.divergence?.(api, 'the dialog is not shown: answered as cancelled', 'loss');
                return OLEUI_CANCEL;
            },
        };
    };

    /**
     * BOOL OleUIAddVerbMenu(LPOLEOBJECT lpOleObj, LPCSTR lpszShortType, HMENU hMenu,
     *     UINT uPos, UINT uIDVerbMin, UINT uIDVerbMax, BOOL bAddConvert, UINT idConvert,
     *     HMENU *lphMenu)
     *
     * The item at uPos becomes the greyed "&Object" the library puts there for
     * no object, *lphMenu gets no cascade, and the answer is FALSE. With an
     * object the library would list its verbs; the same greyed item stands in.
     *
     * @param {0 | 1} wide
     */
    const addVerbMenu = wide=>({
        argBytes: 36,
        /** @param {number[]} args */
        handler: ([object, , menu, position, , , , , cascade])=>{
            if ((cascade >>> 0) !== 0)
            {
                host.writeMemory(wholeAddress(cascade), new Uint8Array(pointer));
            }
            if ((menu >>> 0) !== 0)
            {
                const user32 = host.user32();
                user32.DeleteMenu.handler([menu, position, MF_BYPOSITION]);
                const name = wide ? 'InsertMenuW' : 'InsertMenuA';
                host.lent(textOf(OBJECT_ITEM, wide), at=>user32[name].handler([menu, position,
                    MF_BYPOSITION | MF_STRING | MF_GRAYED, 0, at]));
            }
            if ((object >>> 0) !== 0)
            {
                host.divergence?.(wide ? 'OleUIAddVerbMenuW' : 'OleUIAddVerbMenuA',
                    'the object\'s verbs are not listed: a greyed "Object" item stands in');
            }
            return OLEUI_FALSE;
        },
    });

    return {
        OleUIAddVerbMenuA: addVerbMenu(0),
        OleUIAddVerbMenuW: addVerbMenu(1),
        ...Object.fromEntries(Object.keys(STRUCTURE_SIZES).flatMap(name=>[
            [`OleUI${name}A`, dialog(name, 0)], [`OleUI${name}W`, dialog(name, 1)]])),

        /**
         * BOOL OleUICanConvertOrActivateAs(REFCLSID rClsid, BOOL fIsLinkedObject, WORD wFormat)
         *
         * Whether any server registers itself as able to read or activate this
         * class: the registry's Conversion keys hold that, and no server here
         * registers one, so FALSE.
         */
        OleUICanConvertOrActivateAs: { argBytes: 12, handler: ()=>0 },

        /**
         * BOOL OleUIUpdateLinks(LPOLEUILINKCONTAINER lpOleUILinkCntr, HWND hwndParent,
         *     LPSTR lpszTitle, int cLinks)
         *
         * Updates every link while showing progress; no link is updated
         * here, which the answer FALSE says.
         */
        OleUIUpdateLinksA: updateLinks('OleUIUpdateLinksA'),
        OleUIUpdateLinksW: updateLinks('OleUIUpdateLinksW'),

        /**
         * int OleUIPromptUser(int nTemplate, HWND hwndParent, ...)
         *
         * A message box from one of the library's templates: the button the
         * user pressed, IDCANCEL for a prompt nobody saw.
         */
        OleUIPromptUserA: promptUser('OleUIPromptUserA'),
        OleUIPromptUserW: promptUser('OleUIPromptUserW'),
    };

    /** @param {string} api */
    function updateLinks(api){
        return {
            argBytes: 16,
            handler: ()=>{
                host.divergence?.(api, 'no link is updated', 'loss');
                return 0;
            },
        };
    }

    /** @param {string} api */
    function promptUser(api){
        return {
            convention: 'cdecl',
            argBytes: 8,
            handler: ()=>{
                host.divergence?.(api, 'the prompt is not shown: answered as cancelled', 'loss');
                return IDCANCEL;
            },
        };
    }
}
