/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ImageList_GetIcon: one image of a list as an icon handle, made by user32's
 * CreateIcon from the image's colour and mask planes, so the icon is the
 * same object a program's own CreateIcon makes and DestroyIcon releases.
 */

/**
 * @param {import('./imagelist.js').ImageListHost} host
 * @param {ReturnType<typeof import('./imagelist.js').createImageLists>} lists
 */
export function createImageListIcons(host, lists){
    return {
        /**
         * HICON ImageList_GetIcon(HIMAGELIST himl, int i, UINT flags)
         *
         * The image and its mask, as the list holds them; the drawing flags
         * play no part beyond that, so an overlay the style names is not
         * drawn into the icon. No list, no such image, or no window manager
         * to make an icon with is NULL.
         */
        ImageList_GetIcon: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, index])=>{
                const create = host.user32?.('CreateIcon');
                const allocate = host.allocate;
                const release = host.release;
                if (!create || !allocate || !release)
                {
                    host.divergence?.('ImageList_GetIcon',
                        'no window manager to make an icon with');
                    return 0;
                }
                const planes = lists.iconPlanes(handle >>> 0, index | 0, { allocate, release });
                if (!planes)
                {
                    return 0;
                }
                const block = allocate(planes.and.length + planes.xor.length);
                if (block === 0)
                {
                    return 0;
                }
                try
                {
                    host.writeMemory(block, planes.and);
                    host.writeMemory(block + planes.and.length, planes.xor);
                    return /** @type {number} */ (create.handler([0, planes.cx, planes.cy, 1, 32,
                        block, block + planes.and.length])) >>> 0;
                }
                finally
                {
                    release(block);
                }
            },
        },
    };
}
