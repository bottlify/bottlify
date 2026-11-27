/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An image list as the COM object it is: from Windows XP on an HIMAGELIST is a
 * pointer to an IImageList (IImageList2 from Vista), the same object whichever
 * comctl32 made it, so HIMAGELIST_QueryInterface hands back the handle itself
 * and ImageList_Destroy is a Release (Wine's imagelist test, test_iimagelist
 * and test_imagelist_interop). Each method is the flat export of the same
 * name over this list, answered as an HRESULT, so there is one implementation
 * of every operation.
 */

import { createComObject } from '../ole32/objects.js';
import { formatGuid } from '../../../system/guid.js';

export const IID_IIMAGELIST = '{46EB5926-582E-4017-9FDF-E8998DAA0950}';
export const IID_IIMAGELIST2 = '{192B9D83-50FC-457B-90A0-2B82A8B5DAE1}';
export const CLSID_IMAGELIST = '{7C476BA2-02B1-48F4-8048-B24619DDC058}';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;

/** What a list answers to: its own two interfaces and IUnknown, all one pointer. */
const KNOWN = new Set([IID_IIMAGELIST, IID_IIMAGELIST2, '{00000000-0000-0000-C000-000000000046}']);

/**
 * @typedef {Object} ImageListComHost
 * @property {(object: any, interfaceId: string) => number} publish  the interface's pointer
 * @property {(name: string, args: number[]) => any} flat  a flat export of comctl32's lists
 * @property {(address: number, value: number) => void} putU32
 * @property {(address: number) => Uint8Array} readGuid  sixteen bytes
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(handle: number, cx: number, cy: number, flags: number, initial: number,
 *     grow: number) => boolean} initialize  a list made empty again at a size and depth
 * @property {(handle: number, index: number) => number | null} itemFlags  an image's
 *     ILIF_* flags, null for no such image
 */


/**
 * @param {ImageListComHost} host
 */
export function createImageListObjects(host){
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} method */
    const notDone = method=>{
        if (!said.has(method))
        {
            said.add(method);
            host.divergence?.(`IImageList2::${method}`, 'not implemented: E_NOTIMPL');
        }
        return E_NOTIMPL;
    };
    /** A BOOL export as an HRESULT. @param {any} answer */
    const ok = answer=>(answer ? S_OK : E_FAIL);
    /** One whose only failure is an argument it was given. @param {any} answer */
    const valid = answer=>(answer ? S_OK : E_INVALIDARG);
    /** An index export as an HRESULT, the index written to `out`. */
    const indexed = (/** @type {number} */ answer, /** @type {number} */ out)=>{
        if ((answer | 0) < 0)
        {
            return E_FAIL;
        }
        if ((out >>> 0) !== 0)
        {
            host.putU32(out >>> 0, answer >>> 0);
        }
        return S_OK;
    };
    /**
     * A new list handed out as the interface asked for.
     *
     * @param {number} made @param {number} riid @param {number} out
     */
    const handOut = (made, riid, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        if (made === 0)
        {
            host.putU32(out >>> 0, 0);
            return E_FAIL;
        }
        const object = objects.get(made >>> 0);
        if (!object || !KNOWN.has(formatGuid(host.readGuid(riid >>> 0))))
        {
            host.flat('ImageList_Destroy', [made]);
            host.putU32(out >>> 0, 0);
            return E_NOINTERFACE;
        }
        host.putU32(out >>> 0, made >>> 0);
        return S_OK;
    };

    /**
     * A method: argument bytes after `this`, and what it does with the list's
     * handle and its arguments.
     *
     * @param {string} name @param {number} argBytes
     * @param {((handle: number, args: number[]) => any) | null} body
     */
    const method = (name, argBytes, body)=>({
        name, argBytes: argBytes + 4,
        /** @param {any} object @param {number[]} args */
        invoke: (object, args)=>(body ? body(object.state.handle, args) : notDone(name)),
    });

    const flat = host.flat;
    const LIST = [
        method('Add', 12, (h, [image, mask, out])=>indexed(flat('ImageList_Add', [h, image, mask]),
            out)),
        method('ReplaceIcon', 12, (h, [i, icon, out])=>indexed(
            flat('ImageList_ReplaceIcon', [h, i, icon]), out)),
        method('SetOverlayImage', 8, (h, [image, overlay])=>ok(
            flat('ImageList_SetOverlayImage', [h, image, overlay]))),
        method('Replace', 12, (h, [i, image, mask])=>ok(flat('ImageList_Replace',
            [h, i, image, mask]))),
        method('AddMasked', 12, (h, [image, key, out])=>indexed(
            flat('ImageList_AddMasked', [h, image, key]), out)),
        method('Draw', 4, (h, [params])=>{
            if ((params >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return valid(flat('ImageList_DrawIndirect', [params]));
        }),
        method('Remove', 4, (h, [i])=>valid(flat('ImageList_Remove', [h, i]))),
        method('GetIcon', 12, null),
        method('GetImageInfo', 8, (h, [i, info])=>ok(flat('ImageList_GetImageInfo',
            [h, i, info]))),
        method('Copy', 16, (h, [to, source, from, flags])=>ok(flat('ImageList_Copy',
            [h, to, source, from, flags]))),
        method('Merge', 28, (h, [first, second, other, dx, dy, riid, out])=>handOut(
            flat('ImageList_Merge', [h, first, second, other, dx, dy]), riid, out)),
        method('Clone', 8, (h, [riid, out])=>handOut(flat('ImageList_Duplicate', [h]), riid,
            out)),
        method('GetImageRect', 8, null),
        method('GetIconSize', 8, (h, [cx, cy])=>((cx >>> 0) === 0 || (cy >>> 0) === 0
            ? E_INVALIDARG : ok(flat('ImageList_GetIconSize', [h, cx, cy])))),
        method('SetIconSize', 8, (h, [cx, cy])=>ok(flat('ImageList_SetIconSize', [h, cx, cy]))),
        method('GetImageCount', 4, (h, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.putU32(out >>> 0, flat('ImageList_GetImageCount', [h]) >>> 0);
            return S_OK;
        }),
        method('SetImageCount', 4, (h, [count])=>ok(flat('ImageList_SetImageCount',
            [h, count]))),
        method('SetBkColor', 8, (h, [color, out])=>{
            const before = flat('ImageList_SetBkColor', [h, color]);
            if ((out >>> 0) !== 0)
            {
                host.putU32(out >>> 0, before >>> 0);
            }
            return S_OK;
        }),
        method('GetBkColor', 4, (h, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.putU32(out >>> 0, flat('ImageList_GetBkColor', [h]) >>> 0);
            return S_OK;
        }),
        method('BeginDrag', 12, (h, [i, dx, dy])=>ok(flat('ImageList_BeginDrag', [h, i, dx, dy]))),
        method('EndDrag', 0, ()=>{
            flat('ImageList_EndDrag', []);
            return S_OK;
        }),
        method('DragEnter', 12, (h, [hwnd, x, y])=>ok(flat('ImageList_DragEnter', [hwnd, x, y]))),
        method('DragLeave', 4, (h, [hwnd])=>ok(flat('ImageList_DragLeave', [hwnd]))),
        method('DragMove', 8, (h, [x, y])=>ok(flat('ImageList_DragMove', [x, y]))),
        method('SetDragCursorImage', 16, (h, [cursor, i, dx, dy])=>ok(
            flat('ImageList_SetDragCursorImage', [cursor, i, dx, dy]))),
        method('DragShowNolock', 4, (h, [show])=>ok(flat('ImageList_DragShowNolock', [show]))),
        method('GetDragImage', 16, null),
        method('GetItemFlags', 8, (h, [i, out])=>{
            const flags = host.itemFlags(h, i | 0);
            if (flags === null || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.putU32(out >>> 0, flags);
            return S_OK;
        }),
        method('GetOverlayImage', 8, null),
    ];
    const LIST2 = [
        method('Resize', 8, (h, [cx, cy])=>ok(flat('ImageList_SetIconSize', [h, cx, cy]))),
        method('GetOriginalSize', 16, null),
        method('SetOriginalSize', 12, null),
        method('SetCallback', 4, null),
        method('GetCallback', 8, null),
        method('ForceImagePresent', 8, null),
        method('DiscardImages', 12, null),
        method('PreloadImages', 4, null),
        method('GetStatistics', 4, null),
        method('Initialize', 20, (h, [cx, cy, flags, initial, grow])=>(host.initialize(h, cx | 0,
            cy | 0, flags >>> 0, Math.max(initial | 0, 0), grow | 0) ? S_OK : E_INVALIDARG)),
        method('Replace2', 20, null),
        method('ReplaceFromImageList', 20, null),
    ];

    /** @type {Map<number, any>} handle -> its object */
    const objects = new Map();

    /**
     * The object a new list is, its IImageList pointer the list's handle;
     * `forget` is called once its last reference goes.
     *
     * @param {(handle: number) => void} forget
     * @returns {number} the handle, or 0
     */
    const make = forget=>{
        const state = { handle: 0 };
        const object = createComObject(CLSID_IMAGELIST, {
            // IImageList2 extends IImageList: one record, one pointer, for both.
            interfaces: [{ id: IID_IIMAGELIST2, also: [IID_IIMAGELIST],
                methods: [...LIST, ...LIST2] }],
            state,
            destroy: ()=>{
                objects.delete(state.handle);
                forget(state.handle);
            },
        });
        const pointer = host.publish(object, IID_IIMAGELIST2);
        if (pointer === 0)
        {
            object.release();
            return 0;
        }
        state.handle = pointer;
        objects.set(pointer, object);
        return pointer;
    };

    return {
        make,
        handOut,
        /** @param {number} at @returns {string} */
        guidAt: at=>((at >>> 0) === 0 ? '' : formatGuid(host.readGuid(at >>> 0))),
        /** @param {number} handle */
        objectOf: handle=>objects.get(handle >>> 0) ?? null,
        /**
         * HRESULT HIMAGELIST_QueryInterface(HIMAGELIST himl, REFIID riid, void **ppv)
         *
         * @param {number} handle @param {number} riid @param {number} out
         */
        queryInterface: (handle, riid, out)=>{
            const object = objects.get(handle >>> 0);
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!object)
            {
                host.putU32(out >>> 0, 0);
                return E_INVALIDARG;
            }
            if (!KNOWN.has(formatGuid(host.readGuid(riid >>> 0))))
            {
                host.putU32(out >>> 0, 0);
                return E_NOINTERFACE;
            }
            object.addRef();
            host.putU32(out >>> 0, handle >>> 0);
            return S_OK;
        },
    };
}
