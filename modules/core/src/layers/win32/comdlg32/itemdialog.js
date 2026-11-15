/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The common item dialogs, CLSID_FileOpenDialog and CLSID_FileSaveDialog:
 * Vista's file dialogs as COM objects, which a newer program's save and load
 * screens and its launcher make in place of GetOpenFileName.
 *
 * The object keeps everything a program sets on it and reads back - the
 * options, the file types and which is chosen, the file name, the title and
 * labels, the default extension, the event sinks it is advised of - and
 * answers Show as GetOpenFileName answers here: nobody is in front of it, so
 * the dialog is dismissed without a choice (HRESULT_FROM_WIN32(ERROR_CANCELLED)),
 * which every caller handles, and there is no result to get.
 */

import { readGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** HRESULT_FROM_WIN32(ERROR_CANCELLED): the dialog dismissed without a choice. */
const HRESULT_CANCELLED = 0x800704c7 | 0;

export const CLSID_FILE_OPEN_DIALOG = '{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}';
export const CLSID_FILE_SAVE_DIALOG = '{C0B4E2F3-BA21-4773-8DBA-335EC946EB8B}';
const IID_IMODALWINDOW = '{B4DB1657-70D7-485E-8E3E-6FCB5A5C1802}';
const IID_IFILEDIALOG = '{42F85136-DB7E-439C-85F1-E4075D135FC8}';
const IID_IFILEOPENDIALOG = '{D57C7288-D4AD-4768-BE02-9D969532D960}';
const IID_IFILESAVEDIALOG = '{84BCCD23-5FDE-4CDB-AEA4-AF64B83D78AB}';
const IID_IFILEDIALOG2 = '{61744FC7-85B5-4791-A9B0-272276309B13}';
const IID_IFILEDIALOGCUSTOMIZE = '{E6FDD21A-163F-4975-9C8C-A69F1BA37034}';
const IID_IOLEWINDOW = '{00000114-0000-0000-C000-000000000046}';
const IID_IOBJECTWITHSITE = '{FC4801A3-2BA9-11CF-A229-00AA003D7352}';
const IID_ISERVICEPROVIDER = '{6D5140C1-7436-11CE-8034-00AA006009FA}';
const E_NOINTERFACE = 0x80004002 | 0;

/** The options each dialog starts with, as the documentation of SetOptions gives them. */
const FOS_OVERWRITEPROMPT = 0x00000002;
const FOS_NOCHANGEDIR = 0x00000008;
const FOS_PATHMUSTEXIST = 0x00000800;
const FOS_FILEMUSTEXIST = 0x00001000;
const FOS_NOREADONLYRETURN = 0x00008000;
export const OPEN_OPTIONS = FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST | FOS_NOCHANGEDIR;
export const SAVE_OPTIONS = FOS_OVERWRITEPROMPT | FOS_NOREADONLYRETURN | FOS_PATHMUSTEXIST
    | FOS_NOCHANGEDIR;

/** COMDLG_FILTERSPEC: a name and a pattern, two wide strings. */
const FILTERSPEC_SIZE = 8;
/** How long a dialog's strings may be, in characters. */
const MAX_TEXT = 32767;

/**
 * @typedef {Object} ItemDialogHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} allocate  CoTaskMemAlloc: what the caller frees.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Puts both dialogs where CoCreateInstance will find them.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 * @param {ItemDialogHost} host
 */
export function registerFileDialogClasses(registry, host){
    let told = false;
    /** @param {number} at */
    const read32 = at=>{
        const b = host.readMemory(at >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const write32 = (at, value)=>{
        const v = value >>> 0;
        host.writeMemory(at >>> 0,
            Uint8Array.of(v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24));
    };
    /** @param {number} at */
    const wide = at=>(at >>> 0 === 0 ? null : host.readWideString?.(at >>> 0, MAX_TEXT * 2) ?? '');
    /**
     * A wide string in memory the caller frees with CoTaskMemFree.
     *
     * @param {string} text
     */
    const taskString = text=>{
        const at = host.allocate((text.length + 1) * 2) >>> 0;
        if (at === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i * 2] = text.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = text.charCodeAt(i) >>> 8;
        }
        host.writeMemory(at, bytes);
        return at;
    };

    /**
     * @param {boolean} save
     * @returns {import('../ole32/objects.js').ComMethod[]}
     */
    const dialogMethods = save=>{
        /** @type {[string, number, (state: any, args: number[]) => number][]} */
        const slots = [
            // IModalWindow
            ['Show', 1, ()=>{
                if (!told)
                {
                    told = true;
                    host.divergence?.(save ? 'IFileSaveDialog::Show' : 'IFileOpenDialog::Show',
                        'nobody answers the dialog: it is dismissed without a choice');
                }
                return HRESULT_CANCELLED;
            }],
            // IFileDialog
            ['SetFileTypes', 2, (state, [types, specs])=>{
                if (state.types !== null)
                {
                    return E_UNEXPECTED;
                }
                if (types >>> 0 === 0 || specs >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                state.types = Array.from({ length: types >>> 0 }, (_, i)=>({
                    name: wide(read32(specs + i * FILTERSPEC_SIZE)) ?? '',
                    spec: wide(read32(specs + i * FILTERSPEC_SIZE + 4)) ?? '',
                }));
                return S_OK;
            }],
            ['SetFileTypeIndex', 1, (state, [index])=>{
                state.typeIndex = index >>> 0;
                return S_OK;
            }],
            ['GetFileTypeIndex', 1, (state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                // One-based; the first type once there are types and none was chosen.
                write32(out, state.typeIndex || (state.types !== null ? 1 : 0));
                return S_OK;
            }],
            ['Advise', 2, (state, [sink, cookie])=>{
                if (sink >>> 0 === 0 || cookie >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                const next = ++state.cookies;
                state.sinks.set(next, sink >>> 0);
                write32(cookie, next);
                return S_OK;
            }],
            ['Unadvise', 1, (state, [cookie])=>(state.sinks.delete(cookie >>> 0)
                ? S_OK : E_INVALIDARG)],
            ['SetOptions', 1, (state, [options])=>{
                state.options = options >>> 0;
                return S_OK;
            }],
            ['GetOptions', 1, (state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                write32(out, state.options);
                return S_OK;
            }],
            ['SetDefaultFolder', 1, (_state, [item])=>(item >>> 0 === 0 ? E_INVALIDARG : S_OK)],
            ['SetFolder', 1, (_state, [item])=>(item >>> 0 === 0 ? E_INVALIDARG : S_OK)],
            ['GetFolder', 1, (_state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                write32(out, 0);
                return E_FAIL;
            }],
            ['GetCurrentSelection', 1, (_state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                write32(out, 0);
                return E_FAIL;
            }],
            ['SetFileName', 1, (state, [name])=>{
                state.fileName = wide(name) ?? '';
                return S_OK;
            }],
            ['GetFileName', 1, (state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.fileName === null)
                {
                    write32(out, 0);
                    return E_FAIL;
                }
                const at = taskString(state.fileName);
                write32(out, at);
                return at === 0 ? E_OUTOFMEMORY : S_OK;
            }],
            ['SetTitle', 1, (state, [text])=>{
                state.title = wide(text) ?? '';
                return S_OK;
            }],
            ['SetOkButtonLabel', 1, (state, [text])=>{
                state.okLabel = wide(text) ?? '';
                return S_OK;
            }],
            ['SetFileNameLabel', 1, (state, [text])=>{
                state.nameLabel = wide(text) ?? '';
                return S_OK;
            }],
            ['GetResult', 1, (_state, [out])=>{
                if (out >>> 0 === 0)
                {
                    return E_POINTER;
                }
                // Nothing was chosen: the dialog was never answered.
                write32(out, 0);
                return E_UNEXPECTED;
            }],
            ['AddPlace', 2, (_state, [item])=>(item >>> 0 === 0 ? E_INVALIDARG : S_OK)],
            ['SetDefaultExtension', 1, (state, [text])=>{
                state.extension = wide(text) ?? '';
                return S_OK;
            }],
            ['Close', 1, ()=>S_OK],
            ['SetClientGuid', 1, (state, [guid])=>{
                if (guid >>> 0 === 0)
                {
                    return E_INVALIDARG;
                }
                state.client = readGuid(host, guid);
                return S_OK;
            }],
            ['ClearClientData', 0, ()=>S_OK],
            ['SetFilter', 1, ()=>S_OK],
        ];
        const tail = save
            ? /** @type {typeof slots} */ ([
                ['SetSaveAsItem', 1, (_state, [item])=>(item >>> 0 === 0 ? E_INVALIDARG : S_OK)],
                ['SetProperties', 1, ()=>S_OK],
                ['SetCollectedProperties', 2, ()=>S_OK],
                ['GetProperties', 1, (_state, [out])=>{
                    if (out >>> 0 !== 0)
                    {
                        write32(out, 0);
                    }
                    return E_UNEXPECTED;
                }],
                ['ApplyProperties', 4, ()=>E_UNEXPECTED],
            ])
            : /** @type {typeof slots} */ ([
                ['GetResults', 1, (_state, [out])=>{
                    if (out >>> 0 === 0)
                    {
                        return E_POINTER;
                    }
                    write32(out, 0);
                    return E_UNEXPECTED;
                }],
                ['GetSelectedItems', 1, (_state, [out])=>{
                    if (out >>> 0 === 0)
                    {
                        return E_POINTER;
                    }
                    write32(out, 0);
                    return E_FAIL;
                }],
            ]);
        return [...slots, ...tail].map(([name, words, invoke])=>({
            name, argBytes: 4 + words * 4,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ args)=>
                invoke(object.state, args),
        }));
    };

    /**
     * IFileDialogCustomize: the controls a program adds to the dialog, kept
     * by id with their state, label, text and items - nothing is shown.
     *
     * @type {import('../ole32/objects.js').ComMethod[]}
     */
    const customize = (()=>{
        /** @param {string} name @param {number} words @param {(controls: Map<number, any>, args: number[]) => number} act */
        const slot = (name, words, act)=>({ name, argBytes: 4 + words * 4,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ args)=>
                act(object.state.controls, args) });
        /** @param {string} kind @param {number} words */
        const add = (kind, words)=>(/** @type {Map<number, any>} */ controls,
            /** @type {number[]} */ [id, label])=>
        {
            if (controls.has(id >>> 0))
            {
                return E_UNEXPECTED;
            }
            controls.set(id >>> 0, { kind, state: 3, text: words > 1 ? wide(label) ?? '' : '',
                items: new Map(), selected: -1, checked: 0 });
            return S_OK;
        };
        /** @param {(control: any, args: number[]) => number} act */
        const on = act=>(/** @type {Map<number, any>} */ controls, /** @type {number[]} */ args)=>{
            const control = controls.get(args[0] >>> 0);
            return control ? act(control, args) : E_INVALIDARG;
        };
        return [
            slot('EnableOpenDropDown', 1, add('dropdown', 1)),
            slot('AddMenu', 2, add('menu', 2)),
            slot('AddPushButton', 2, add('button', 2)),
            slot('AddComboBox', 1, add('combo', 1)),
            slot('AddRadioButtonList', 1, add('radio', 1)),
            slot('AddCheckButton', 3, (controls, args)=>{
                const answer = add('check', 2)(controls, args);
                if (answer === S_OK)
                {
                    controls.get(args[0] >>> 0).checked = args[2] ? 1 : 0;
                }
                return answer;
            }),
            slot('AddEditBox', 2, add('edit', 2)),
            slot('AddSeparator', 1, add('separator', 1)),
            slot('AddText', 2, add('text', 2)),
            slot('SetControlLabel', 2, on((control, [, label])=>{
                control.text = wide(label) ?? '';
                return S_OK;
            })),
            slot('GetControlState', 2, on((control, [, out])=>{
                write32(out, control.state);
                return S_OK;
            })),
            slot('SetControlState', 2, on((control, [, value])=>{
                control.state = value >>> 0;
                return S_OK;
            })),
            slot('GetEditBoxText', 2, on((control, [, out])=>{
                const at = taskString(control.text);
                write32(out, at);
                return at === 0 ? E_OUTOFMEMORY : S_OK;
            })),
            slot('SetEditBoxText', 2, on((control, [, text])=>{
                control.text = wide(text) ?? '';
                return S_OK;
            })),
            slot('GetCheckButtonState', 2, on((control, [, out])=>{
                write32(out, control.checked);
                return S_OK;
            })),
            slot('SetCheckButtonState', 2, on((control, [, value])=>{
                control.checked = value ? 1 : 0;
                return S_OK;
            })),
            slot('AddControlItem', 3, on((control, [, item, label])=>{
                if (control.items.has(item >>> 0))
                {
                    return E_INVALIDARG;
                }
                control.items.set(item >>> 0, { text: wide(label) ?? '', state: 3 });
                return S_OK;
            })),
            slot('RemoveControlItem', 2, on((control, [, item])=>
                (control.items.delete(item >>> 0) ? S_OK : E_INVALIDARG))),
            slot('RemoveAllControlItems', 1, on(control=>{
                control.items.clear();
                return S_OK;
            })),
            slot('GetControlItemState', 3, on((control, [, item, out])=>{
                const entry = control.items.get(item >>> 0);
                if (!entry)
                {
                    return E_INVALIDARG;
                }
                write32(out, entry.state);
                return S_OK;
            })),
            slot('SetControlItemState', 3, on((control, [, item, value])=>{
                const entry = control.items.get(item >>> 0);
                if (!entry)
                {
                    return E_INVALIDARG;
                }
                entry.state = value >>> 0;
                return S_OK;
            })),
            slot('GetSelectedControlItem', 2, on((control, [, out])=>{
                if (control.selected < 0)
                {
                    return E_FAIL;
                }
                write32(out, control.selected);
                return S_OK;
            })),
            slot('SetSelectedControlItem', 2, on((control, [, item])=>{
                if (!control.items.has(item >>> 0))
                {
                    return E_INVALIDARG;
                }
                control.selected = item >>> 0;
                return S_OK;
            })),
            slot('StartVisualGroup', 2, add('group', 2)),
            slot('EndVisualGroup', 0, ()=>S_OK),
            slot('MakeProminent', 1, on(()=>S_OK)),
            slot('SetControlItemText', 3, on((control, [, item, label])=>{
                const entry = control.items.get(item >>> 0);
                if (!entry)
                {
                    return E_INVALIDARG;
                }
                entry.text = wide(label) ?? '';
                return S_OK;
            })),
        ];
    })();
    /** IOleWindow: no window until the dialog is shown, and it never is. */
    const oleWindow = [
        { name: 'GetWindow', argBytes: 8, invoke: (/** @type {any} */ _object,
            /** @type {number[]} */ [out])=>
        {
            if (out >>> 0 === 0)
            {
                return E_INVALIDARG;
            }
            write32(out, 0);
            return S_OK;
        } },
        { name: 'ContextSensitiveHelp', argBytes: 8, invoke: ()=>S_OK },
    ];
    /** IObjectWithSite: a site kept and handed back. */
    const withSite = [
        { name: 'SetSite', argBytes: 8, invoke: (/** @type {any} */ object,
            /** @type {number[]} */ [site])=>
        {
            object.state.site = site >>> 0;
            return S_OK;
        } },
        { name: 'GetSite', argBytes: 12, invoke: (/** @type {any} */ _object,
            /** @type {number[]} */ [, out])=>
        {
            if (out >>> 0 !== 0)
            {
                write32(out, 0);
            }
            return E_FAIL;
        } },
    ];

    /** IServiceProvider: the dialog offers no service of its own while it is not shown. */
    const services = [
        { name: 'QueryService', argBytes: 16, invoke: (/** @type {any} */ _object,
            /** @type {number[]} */ [, , out])=>
        {
            if (out >>> 0 !== 0)
            {
                write32(out, 0);
            }
            return E_NOINTERFACE;
        } },
    ];

    for (const save of [false, true])
    {
        const methods = dialogMethods(save);
        // IFileDialog's own slots, without the open or save dialog's at the end.
        const common = methods.slice(0, 23);
        /** IFileDialog2: IFileDialog's, then a cancel button's label and a navigation root. */
        const second = [...common,
            { name: 'SetCancelButtonLabel', argBytes: 8, invoke: ()=>S_OK },
            { name: 'SetNavigationRoot', argBytes: 8, invoke: (/** @type {any} */ _object,
                /** @type {number[]} */ [item])=>(item >>> 0 === 0 ? E_INVALIDARG : S_OK) }];
        registry.registerClass(save ? CLSID_FILE_SAVE_DIALOG : CLSID_FILE_OPEN_DIALOG, ()=>({
            interfaces: [
                { id: save ? IID_IFILESAVEDIALOG : IID_IFILEOPENDIALOG, methods },
                { id: IID_IFILEDIALOG, methods: common },
                { id: IID_IFILEDIALOG2, methods: second },
                { id: IID_IMODALWINDOW, methods: common.slice(0, 1) },
                { id: IID_IFILEDIALOGCUSTOMIZE, methods: customize },
                { id: IID_IOLEWINDOW, methods: oleWindow },
                { id: IID_IOBJECTWITHSITE, methods: withSite },
                { id: IID_ISERVICEPROVIDER, methods: services },
            ],
            state: { save, types: null, typeIndex: 0, options: save ? SAVE_OPTIONS : OPEN_OPTIONS,
                fileName: null, title: '', okLabel: '', nameLabel: '', extension: '',
                client: null, sinks: new Map(), cookies: 0, controls: new Map(), site: 0 },
        }));
    }
}
