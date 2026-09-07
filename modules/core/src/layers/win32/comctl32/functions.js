/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * comctl32 — image lists, and the mouse-tracking request.
 *
 * An image list is a strip of same-sized bitmaps addressed by index, and that
 * index is the whole of what a caller depends on here: it adds a bitmap, keeps
 * the index it was given, and passes that index back later. Nothing in this
 * build draws one, so the bitmaps themselves go nowhere -- but the indices have
 * to be the ones a real list would hand out, because a caller that adds a strip
 * of eight and is told it added one will index seven images that do not exist.
 *
 * Which is why the width of the bitmap matters even here: a real list divides
 * it by the list's own image width to learn how many images arrived. That
 * division needs the bitmap's dimensions, which belong to gdi32 and arrive
 * through the host; without them a bitmap counts as one image and the list says
 * so rather than guessing.
 */

/** ImageList_Add and friends report failure with this, not with zero. */
const FAILED = -1;

/**
 * @typedef {Object} ComctlHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bitmap: number) => { width: number, height: number } | null} [bitmapSize]
 *           How large a bitmap handle is, for counting the images in a strip.
 *           Absent in a build without gdi32 behind it, and then a strip counts
 *           as the single image it can be sure of.
 */

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** A POINT: two signed longs. @param {number} x @param {number} y */
const point32 = (x, y)=>new Uint8Array([
    x & 0xff, x >> 8 & 0xff, x >> 16 & 0xff, x >> 24 & 0xff,
    y & 0xff, y >> 8 & 0xff, y >> 16 & 0xff, y >> 24 & 0xff,
]);

/**
 * @param {ComctlHost} host
 */
export function createComctlFunctions(host){
    /**
     * @typedef {Object} ImageList
     * @property {number} cx
     * @property {number} cy
     * @property {number[]} images  The bitmap handle behind each index.
     */

    /** @type {Map<number, ImageList>} */
    const lists = new Map();
    let nextHandle = 0x2000;

    /** What a drag in progress has been told, and reads back. */
    let drag = { list: 0, image: 0, dx: 0, dy: 0, window: 0, x: 0, y: 0, shown: true };
    let dragging = false;

    /** @param {number} handle */
    const listOf = handle=>lists.get(handle >>> 0) ?? null;

    /**
     * How many images a bitmap holds for a list of this width.
     *
     * @param {ImageList} list
     * @param {number} bitmap
     */
    const countIn = (list, bitmap)=>{
        const size = host.bitmapSize?.(bitmap >>> 0) ?? null;
        if (!size || list.cx <= 0)
        {
            return 1;
        }
        return Math.max(1, Math.floor(size.width / list.cx));
    };

    return {
        /**
         * HIMAGELIST ImageList_Create(int cx, int cy, UINT flags, int cInitial,
         *                             int cGrow)
         */
        ImageList_Create: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([cx, cy])=>{
                if ((cx | 0) <= 0 || (cy | 0) <= 0)
                {
                    return 0;
                }
                const handle = nextHandle++;
                lists.set(handle, { cx: cx | 0, cy: cy | 0, images: [] });
                return handle;
            },
        },

        /** BOOL ImageList_Destroy(HIMAGELIST himl) */
        ImageList_Destroy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>lists.delete(handle >>> 0) ? 1 : 0,
        },

        /**
         * int ImageList_Add(HIMAGELIST himl, HBITMAP hbmImage, HBITMAP hbmMask)
         *
         * Answers with the index of the *first* image added, which is what a
         * caller keeps when it adds several at once.
         */
        ImageList_Add: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, bitmap])=>{
                const list = listOf(handle);
                if (!list)
                {
                    return FAILED;
                }
                const first = list.images.length;
                for (let at = 0; at < countIn(list, bitmap); at++)
                {
                    list.images.push(bitmap >>> 0);
                }
                return first;
            },
        },

        /** BOOL ImageList_Replace(HIMAGELIST, int i, HBITMAP, HBITMAP) */
        ImageList_Replace: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, index, bitmap])=>{
                const list = listOf(handle);
                if (!list || (index | 0) < 0 || (index | 0) >= list.images.length)
                {
                    return 0;
                }
                list.images[index | 0] = bitmap >>> 0;
                return 1;
            },
        },

        /** int ImageList_GetImageCount(HIMAGELIST himl) */
        ImageList_GetImageCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>listOf(handle)?.images.length ?? 0,
        },

        /**
         * BOOL ImageList_BeginDrag(HIMAGELIST, int iTrack, int dxHotspot,
         *                          int dyHotspot)
         *
         * The drag is state, and the only thing that reads it is the rest of
         * this family. Beginning one on an index the list does not have is the
         * failure a caller checks.
         */
        ImageList_BeginDrag: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, track, dx, dy])=>{
                const list = listOf(handle);
                if (!list || (track | 0) < 0 || (track | 0) >= list.images.length)
                {
                    return 0;
                }
                drag = {
                    list: handle >>> 0, image: track | 0, dx: dx | 0, dy: dy | 0,
                    window: 0, x: 0, y: 0, shown: true,
                };
                dragging = true;
                return 1;
            },
        },

        /** void ImageList_EndDrag(void) */
        ImageList_EndDrag: {
            argBytes: 0,
            handler: ()=>{
                dragging = false;
                return 0;
            },
        },

        /** BOOL ImageList_DragEnter(HWND hwndLock, int x, int y) */
        ImageList_DragEnter: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([window, x, y])=>{
                if (!dragging)
                {
                    return 0;
                }
                drag = { ...drag, window: window >>> 0, x: x | 0, y: y | 0 };
                return 1;
            },
        },

        /** BOOL ImageList_DragLeave(HWND hwndLock) */
        ImageList_DragLeave: {
            argBytes: 4,
            handler: ()=>{
                drag = { ...drag, window: 0 };
                return dragging ? 1 : 0;
            },
        },

        /** BOOL ImageList_DragMove(int x, int y) */
        ImageList_DragMove: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([x, y])=>{
                if (!dragging)
                {
                    return 0;
                }
                drag = { ...drag, x: x | 0, y: y | 0 };
                return 1;
            },
        },

        /** BOOL ImageList_DragShowNolock(BOOL fShow) */
        ImageList_DragShowNolock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([show])=>{
                drag = { ...drag, shown: (show | 0) !== 0 };
                return dragging ? 1 : 0;
            },
        },

        /**
         * HIMAGELIST ImageList_GetDragImage(POINT *ppt, POINT *pptHotspot)
         *
         * What the drag family has been told, read back. Both pointers are
         * optional, which is the only reason the state above is kept at all --
         * a caller asks where the drag thinks it is.
         */
        ImageList_GetDragImage: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([point, hotspot])=>{
                if (!dragging)
                {
                    return 0;
                }
                if ((point >>> 0) !== 0)
                {
                    host.writeMemory(point >>> 0, point32(drag.x, drag.y));
                }
                if ((hotspot >>> 0) !== 0)
                {
                    host.writeMemory(hotspot >>> 0, point32(drag.dx, drag.dy));
                }
                return drag.list;
            },
        },

        /**
         * BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *picce)
         *
         * The structure names which control classes to register. There are no
         * common controls here to register, but the size check is what a caller
         * of the wrong vintage trips on, and reporting that honestly is better
         * than accepting a structure we did not understand.
         */
        InitCommonControlsEx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([controls])=>{
                const size = u32(host.readMemory(controls >>> 0, 4), 0);
                return size === 8 ? 1 : 0;
            },
        },

        /**
         * BOOL _TrackMouseEvent(LPTRACKMOUSEEVENT lpEventTrack)
         *
         * A request to be sent WM_MOUSELEAVE or WM_MOUSEHOVER later. The
         * request is accepted and recorded; the messages are not delivered,
         * because delivering them needs an input layer this build does not
         * have. A program treats those messages as a nicety and a refusal here
         * as an error, so the honest failure is the worse of the two.
         */
        _TrackMouseEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([track])=>{
                const size = u32(host.readMemory(track >>> 0, 4), 0);
                return size === 16 ? 1 : 0;
            },
        },
    };
}
