/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell's drag-and-drop helper, CLSID_DragDropHelper: the object a drop
 * target tells of a drag passing over it, and a drag source hands its image
 * to, so the shell draws the image under the cursor. One object answers
 * IDropTargetHelper and both IDragSourceHelper interfaces (Wine's
 * test_dragdrophelper).
 *
 * Nothing here draws a drag image: every notice is taken and answered S_OK,
 * which is what a program sees on Windows when the image is not shown -- the
 * drag itself is OLE's DoDragDrop, not this object's.
 */

const S_OK = 0;

export const CLSID_DRAG_DROP_HELPER = '{4657278A-411B-11D2-839A-00C04FD918D0}';
const IID_IDROP_TARGET_HELPER = '{4657278B-411B-11D2-839A-00C04FD918D0}';
const IID_IDRAG_SOURCE_HELPER = '{DE5BF786-477A-11D2-839D-00C04FD918D0}';
const IID_IDRAG_SOURCE_HELPER2 = '{83E07D0D-0C5F-4163-BF1A-60B274051E40}';

/**
 * Methods in vtable order, by the argument words each takes after `this`.
 *
 * @param {[name: string, words: number][]} slots
 * @returns {import('../ole32/objects.js').ComMethod[]}
 */
const accepting = slots=>slots.map(([name, words])=>({
    name, argBytes: 4 + words * 4, invoke: ()=>S_OK,
}));

/** IDropTargetHelper: DragEnter(hwnd, data, ppt, effect), DragLeave, DragOver, Drop, Show. */
const DROP_TARGET = Object.freeze(accepting([['DragEnter', 4], ['DragLeave', 0],
    ['DragOver', 2], ['Drop', 3], ['Show', 1]]));
/** IDragSourceHelper: InitializeFromBitmap(image, data), InitializeFromWindow(hwnd, ppt, data). */
const DRAG_SOURCE = Object.freeze(accepting([['InitializeFromBitmap', 2],
    ['InitializeFromWindow', 3]]));
/** IDragSourceHelper2: IDragSourceHelper's, then SetFlags(flags). */
const DRAG_SOURCE2 = Object.freeze([...DRAG_SOURCE, ...accepting([['SetFlags', 1]])]);

/**
 * Puts the helper where CoCreateInstance will find it.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 */
export function registerDragDropHelperClass(registry){
    registry.registerClass(CLSID_DRAG_DROP_HELPER, ()=>({
        interfaces: [
            { id: IID_IDROP_TARGET_HELPER, methods: [...DROP_TARGET] },
            { id: IID_IDRAG_SOURCE_HELPER, methods: [...DRAG_SOURCE] },
            { id: IID_IDRAG_SOURCE_HELPER2, methods: [...DRAG_SOURCE2] },
        ],
    }));
}
