/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32's image lists.
 *
 * An image list is a strip of same-sized images addressed by index. The
 * indices are what a caller keeps: it adds a bitmap, keeps the index it was
 * given, and passes that index back to draw. A strip of eight added at once
 * is eight indices, which is why the added bitmap's width is divided by the
 * list's image width; that needs the bitmap's size, which is gdi32's and
 * arrives through the host, and without it a bitmap counts as one image.
 *
 * The pixels are the list's own, copied when an image is added, because a
 * program deletes the bitmap it added once the call returns: one bitmap
 * holding every image side by side at the list's own depth, and one
 * monochrome mask beside it when the list was made with ILC_MASK. A mask bit
 * is 1 where the image is transparent, and the image is black there, so that
 * drawing is two raster operations: AND the mask in, OR the image over it.
 * Every pixel moves through gdi32's own calls, handed in by the host; a build
 * without gdi32 behind it keeps the indices and draws nothing.
 */

/** ImageList_Add and friends report failure with this, not with zero. */
const FAILED = -1;

/** ImageList_Create's flag for a list with a mask. */
const ILC_MASK = 0x0001;

/** How an image is drawn. The blend flags are accepted and drawn as normal. */
const ILD_TRANSPARENT = 0x0001;
const ILD_MASK = 0x0010;
const ILD_IMAGE = 0x0020;
const ILD_ROP = 0x0040;

/** A colour that is none, and one that is the list's own. */
const CLR_NONE = 0xffffffff;
const CLR_DEFAULT = 0xff000000;

/** Raster operations. DSna clears the destination where the source is set. */
const SRCCOPY = 0x00cc0020;
const SRCAND = 0x008800c6;
const SRCPAINT = 0x00ee0086;
const DSNA = 0x00220326;
const PATCOPY = 0x00f00021;
const BLACKNESS = 0x00000042;

/** IMAGELISTDRAWPARAMS, and the smallest size of it a caller may pass. */
const IMAGELISTDRAWPARAMS = Object.freeze({
    cbSize: 0, himl: 4, i: 8, hdcDst: 12, x: 16, y: 20, cx: 24, cy: 28, xBitmap: 32,
    yBitmap: 36, rgbBk: 40, rgbFg: 44, fStyle: 48, dwRop: 52, V3_SIZE: 56,
});

/** A POINT: two signed longs. @param {number} x @param {number} y */
const point32 = (x, y)=>new Uint8Array([
    x & 0xff, x >> 8 & 0xff, x >> 16 & 0xff, x >> 24 & 0xff,
    y & 0xff, y >> 8 & 0xff, y >> 16 & 0xff, y >> 24 & 0xff,
]);

/** @param {number[]} values @returns {Uint8Array} them as little-endian DWORDs */
const dwords = values=>new Uint8Array(new Uint32Array(values.map(value=>value >>> 0)).buffer);

/**
 * @typedef {Object} ImageListHost
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bitmap: number) => { width: number, height: number } | null} [bitmapSize]
 *           How large a bitmap handle is, for counting the images in a strip.
 *           Absent in a build without gdi32 behind it, and then a strip counts
 *           as the single image it can be sure of.
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [gdi32]
 *           gdi32's exports, which the list's pixels are copied and drawn with.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {ReturnType<typeof createImageLists>} [imageLists]  The lists to
 *           export, when the host built them itself to share with the
 *           controls that draw from them.
 */

/**
 * The image list family's exports, the host's own lists when it built them.
 *
 * @param {ImageListHost} host
 */
export function createImageListFunctions(host){
    return (host.imageLists ?? createImageLists(host)).functions;
}

/**
 * The lists, their exports, and what a control that shows their images asks
 * of them: an image's size, and an image drawn through its mask.
 *
 * @param {ImageListHost} host
 */
export function createImageLists(host){
    /**
     * @typedef {Object} ImageList
     * @property {number} cx
     * @property {number} cy
     * @property {number} flags
     * @property {number} count     How many images it holds.
     * @property {number} capacity  How many its bitmaps have room for.
     * @property {number} image     The bitmap every image sits in, side by side.
     * @property {number} mask      Its monochrome mask, or 0 without ILC_MASK.
     * @property {number} background  What ILD_NORMAL fills behind the image.
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
     * One of gdi32's exports called as a program would call it, or zero
     * without gdi32.
     *
     * @param {string} name @param {...number} args
     * @returns {number}
     */
    const gdi = (name, ...args)=>host.gdi32?.(name)?.handler(args) ?? 0;

    /**
     * Runs `action` with a memory DC of its own for each bitmap named, which
     * are selected into them, and deletes the DCs after.
     *
     * @template T
     * @param {number[]} bitmaps @param {(...dcs: number[]) => T} action
     * @returns {T}
     */
    const withDCs = (bitmaps, action)=>{
        const dcs = bitmaps.map(bitmap=>{
            const dc = gdi('CreateCompatibleDC', 0);
            gdi('SelectObject', dc, bitmap);
            return dc;
        });
        try
        {
            return action(...dcs);
        }
        finally
        {
            dcs.forEach(dc=>gdi('DeleteDC', dc));
        }
    };

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

    /**
     * Makes room for `needed` images, twice as many as there were when it
     * grows, the images already there carried over.
     *
     * @param {ImageList} list @param {number} needed
     */
    const reserve = (list, needed)=>{
        if (!host.gdi32 || needed <= list.capacity)
        {
            return;
        }
        const capacity = Math.max(needed, list.capacity * 2, 4);
        const width = list.cx * capacity;
        const image = gdi('CreateBitmap', width, list.cy, 1, 32, 0);
        const mask = (list.flags & ILC_MASK) !== 0
            ? gdi('CreateBitmap', width, list.cy, 1, 1, 0)
            : 0;
        /** @type {[number, number][]} */
        const pairs = [[list.image, image], [list.mask, mask]];
        for (const [from, to] of pairs)
        {
            if (from !== 0 && to !== 0)
            {
                withDCs([to, from], (target, source)=>gdi('BitBlt', target, 0, 0,
                    list.cx * list.count, list.cy, source, 0, 0, SRCCOPY));
            }
            if (from !== 0)
            {
                gdi('DeleteObject', from);
            }
        }
        Object.assign(list, { image, mask, capacity });
    };

    /**
     * Copies one image into its place in the list: from `bitmap` at `from`,
     * its mask from `mask` or, with none, from where `bitmap` is the colour
     * `key`, or else opaque; and blackens the image where the mask is set.
     *
     * @param {ImageList} list @param {number} index @param {number} bitmap
     * @param {number} from @param {number} mask @param {number | null} [key]
     */
    const place = (list, index, bitmap, from, mask, key = null)=>{
        const x = index * list.cx;
        withDCs([list.image, bitmap], (target, source)=>gdi('BitBlt', target, x, 0, list.cx,
            list.cy, source, from, 0, SRCCOPY));
        if (list.mask === 0)
        {
            return;
        }
        withDCs([list.mask, mask !== 0 ? mask : bitmap], (target, source)=>{
            if (mask !== 0)
            {
                gdi('BitBlt', target, x, 0, list.cx, list.cy, source, from, 0, SRCCOPY);
            }
            else if (key !== null)
            {
                // Into monochrome, a colour source is 1 exactly where it is
                // its DC's background colour.
                gdi('SetBkColor', source, key);
                gdi('BitBlt', target, x, 0, list.cx, list.cy, source, from, 0, SRCCOPY);
            }
            else
            {
                gdi('PatBlt', target, x, 0, list.cx, list.cy, BLACKNESS);
            }
        });
        // Out of monochrome, a 1 is the destination's background colour,
        // white in a new DC: DSna clears the image under it.
        withDCs([list.image, list.mask], (target, source)=>gdi('BitBlt', target, x, 0, list.cx,
            list.cy, source, x, 0, DSNA));
    };

    /**
     * Adds every image a bitmap holds.
     *
     * @param {number} handle @param {number} bitmap @param {number} mask
     * @param {number | null} key
     */
    const add = (handle, bitmap, mask, key)=>{
        const list = listOf(handle);
        if (!list)
        {
            return FAILED;
        }
        const first = list.count;
        const count = countIn(list, bitmap);
        reserve(list, first + count);
        if (host.gdi32 && (bitmap >>> 0) !== 0)
        {
            for (let at = 0; at < count; at++)
            {
                place(list, first + at, bitmap >>> 0, at * list.cx, mask >>> 0, key);
            }
        }
        list.count += count;
        return first;
    };

    /**
     * @typedef {Object} DrawRequest
     * @property {number} handle @property {number} index @property {number} hdc
     * @property {number} x @property {number} y
     * @property {number} [cx]  How much of the image, from xBitmap; 0 for all.
     * @property {number} [cy]
     * @property {number} [xBitmap] @property {number} [yBitmap]
     * @property {number} [background]  CLR_NONE, CLR_DEFAULT or a COLORREF.
     * @property {number} style
     * @property {number} [rop]  ILD_ROP's raster operation.
     */

    /**
     * Draws an image as ImageList_DrawIndirect does: through the mask onto
     * what is there, or onto the background colour when there is one; the
     * mask itself for ILD_MASK; the image alone for ILD_IMAGE, or when the
     * list has no mask; and by the caller's raster operation for ILD_ROP.
     *
     * @param {DrawRequest} request
     * @returns {boolean} false for no list, no such image or no DC
     */
    const drawImage = request=>{
        const list = listOf(request.handle);
        const index = request.index | 0;
        if (!list || index < 0 || index >= list.count || (request.hdc >>> 0) === 0)
        {
            return false;
        }
        if (!host.gdi32 || list.image === 0)
        {
            host.divergence?.('ImageList_Draw', 'an image list is not drawn without gdi32');
            return false;
        }
        const hdc = request.hdc >>> 0;
        const within = request.xBitmap ?? 0;
        const top = request.yBitmap ?? 0;
        const width = (request.cx ?? 0) > 0 ? Math.min(request.cx ?? 0, list.cx - within)
            : list.cx - within;
        const height = (request.cy ?? 0) > 0 ? Math.min(request.cy ?? 0, list.cy - top)
            : list.cy - top;
        const from = index * list.cx + within;
        /** @param {number} bitmap @param {number} rop */
        const blit = (bitmap, rop)=>withDCs([bitmap], source=>gdi('BitBlt', hdc, request.x,
            request.y, width, height, source, from, top, rop));
        const style = request.style >>> 0;
        if ((style & ILD_ROP) !== 0)
        {
            blit(list.image, request.rop ?? SRCCOPY);
            return true;
        }
        if (list.mask === 0 || (style & ILD_IMAGE) !== 0)
        {
            blit(list.image, SRCCOPY);
            return true;
        }
        // The mask goes onto the destination in black and white whatever
        // colours the DC has, so they are set for the blit and put back.
        const text = gdi('SetTextColor', hdc, 0x000000);
        const back = gdi('SetBkColor', hdc, 0xffffff);
        if ((style & ILD_MASK) !== 0)
        {
            blit(list.mask, SRCCOPY);
        }
        else
        {
            const background = (request.background ?? CLR_DEFAULT) >>> 0 === CLR_DEFAULT
                ? list.background
                : (request.background ?? CLR_NONE) >>> 0;
            if ((style & ILD_TRANSPARENT) === 0 && background !== CLR_NONE)
            {
                const brush = gdi('CreateSolidBrush', background);
                const previous = gdi('SelectObject', hdc, brush);
                gdi('PatBlt', hdc, request.x, request.y, width, height, PATCOPY);
                gdi('SelectObject', hdc, previous);
                gdi('DeleteObject', brush);
            }
            blit(list.mask, SRCAND);
            blit(list.image, SRCPAINT);
        }
        gdi('SetTextColor', hdc, text);
        gdi('SetBkColor', hdc, back);
        return true;
    };

    const functions = {
        /**
         * HIMAGELIST ImageList_Create(int cx, int cy, UINT flags, int cInitial,
         *                             int cGrow)
         */
        ImageList_Create: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([cx, cy, flags, initial])=>{
                if ((cx | 0) <= 0 || (cy | 0) <= 0)
                {
                    return 0;
                }
                const handle = nextHandle++;
                /** @type {ImageList} */
                const list = { cx: cx | 0, cy: cy | 0, flags: flags >>> 0, count: 0, capacity: 0,
                    image: 0, mask: 0, background: CLR_NONE };
                reserve(list, Math.max(1, initial | 0));
                lists.set(handle, list);
                return handle;
            },
        },

        /** BOOL ImageList_Destroy(HIMAGELIST himl): its bitmaps go with it. */
        ImageList_Destroy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const list = listOf(handle);
                if (!list)
                {
                    return 0;
                }
                [list.image, list.mask].filter(bitmap=>bitmap !== 0)
                    .forEach(bitmap=>gdi('DeleteObject', bitmap));
                lists.delete(handle >>> 0);
                return 1;
            },
        },

        /**
         * int ImageList_Add(HIMAGELIST himl, HBITMAP hbmImage, HBITMAP hbmMask)
         * int ImageList_AddMasked(HIMAGELIST himl, HBITMAP hbmImage, COLORREF crMask)
         *
         * Answer with the index of the *first* image added, which is what a
         * caller keeps when it adds several at once. The bitmaps are copied
         * and stay the caller's; AddMasked's mask is where the image is the
         * colour named.
         */
        ImageList_Add: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, bitmap, mask])=>add(handle, bitmap, mask ?? 0, null),
        },
        ImageList_AddMasked: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, bitmap, key])=>add(handle, bitmap, 0, key >>> 0),
        },

        /** BOOL ImageList_Replace(HIMAGELIST, int i, HBITMAP, HBITMAP) */
        ImageList_Replace: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, index, bitmap, mask])=>{
                const list = listOf(handle);
                if (!list || (index | 0) < 0 || (index | 0) >= list.count)
                {
                    return 0;
                }
                if (host.gdi32 && (bitmap >>> 0) !== 0)
                {
                    place(list, index | 0, bitmap >>> 0, 0, (mask ?? 0) >>> 0);
                }
                return 1;
            },
        },

        /**
         * int ImageList_ReplaceIcon(HIMAGELIST himl, int i, HICON hicon)
         *
         * An icon into place i, or appended when i is -1; the index it went to,
         * or -1. The place is made and counted as Windows makes it, but its
         * pixels stay blank: an icon is drawn by user32, which this list
         * cannot reach, and a list that refused would stop the program.
         */
        ImageList_ReplaceIcon: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, index, icon])=>{
                const list = listOf(handle);
                const at = index | 0;
                if (!list || (icon >>> 0) === 0 || at < -1 || at >= list.count)
                {
                    return -1;
                }
                host.divergence?.('ImageList_ReplaceIcon', 'the pixels of the icon are not drawn');
                if (at !== -1)
                {
                    return at;
                }
                reserve(list, list.count + 1);
                list.count++;
                return list.count - 1;
            },
        },

        /**
         * BOOL ImageList_Remove(HIMAGELIST himl, int i)
         *
         * The images after it move down one; -1 removes them all.
         */
        ImageList_Remove: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, index])=>{
                const list = listOf(handle);
                if (!list || (index | 0) < -1 || (index | 0) >= list.count)
                {
                    return 0;
                }
                if ((index | 0) === -1)
                {
                    list.count = 0;
                    return 1;
                }
                const at = (index | 0) * list.cx;
                for (const bitmap of [list.image, list.mask].filter(held=>held !== 0))
                {
                    withDCs([bitmap], dc=>gdi('BitBlt', dc, at, 0, (list.count - 1) * list.cx - at,
                        list.cy, dc, at + list.cx, 0, SRCCOPY));
                }
                list.count--;
                return 1;
            },
        },

        /** int ImageList_GetImageCount(HIMAGELIST himl) */
        ImageList_GetImageCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>listOf(handle)?.count ?? 0,
        },

        /** BOOL ImageList_GetIconSize(HIMAGELIST himl, int *cx, int *cy) */
        ImageList_GetIconSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, cx, cy])=>{
                const list = listOf(handle);
                if (!list || (cx >>> 0) === 0 || (cy >>> 0) === 0)
                {
                    return 0;
                }
                host.writeMemory(cx >>> 0, dwords([list.cx]));
                host.writeMemory(cy >>> 0, dwords([list.cy]));
                return 1;
            },
        },

        /**
         * COLORREF ImageList_SetBkColor(HIMAGELIST himl, COLORREF clrBk)
         * COLORREF ImageList_GetBkColor(HIMAGELIST himl)
         *
         * What ILD_NORMAL draws behind an image's transparent pixels; CLR_NONE,
         * the default, draws nothing there.
         */
        ImageList_SetBkColor: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, color])=>{
                const list = listOf(handle);
                if (!list)
                {
                    return CLR_NONE;
                }
                const previous = list.background;
                list.background = color >>> 0;
                return previous;
            },
        },
        ImageList_GetBkColor: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>listOf(handle)?.background ?? CLR_NONE,
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
                if (!list || (track | 0) < 0 || (track | 0) >= list.count)
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
         * BOOL ImageList_Draw(HIMAGELIST, int i, HDC, int x, int y, UINT fStyle)
         * BOOL ImageList_DrawEx(HIMAGELIST, int i, HDC, int x, int y, int dx, int dy,
         *                       COLORREF rgbBk, COLORREF rgbFg, UINT fStyle)
         * BOOL ImageList_DrawIndirect(IMAGELISTDRAWPARAMS *pimldp)
         *
         * One drawing, three spellings: ImageList_Draw takes the list's own
         * background colour, DrawEx names one and how much of the image,
         * DrawIndirect names everything, a raster operation included, in a
         * structure no smaller than its version-3 size (Wine's
         * test_DrawIndirect). No list, no DC or an index past the end fails.
         */
        ImageList_Draw: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, index, hdc, x, y, style])=>(drawImage({
                handle, index, hdc, x: x | 0, y: y | 0, style,
            }) ? 1 : 0),
        },
        ImageList_DrawEx: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, index, hdc, x, y, dx, dy, background, , style])=>(drawImage({
                handle, index, hdc, x: x | 0, y: y | 0, cx: dx | 0, cy: dy | 0,
                background: background >>> 0, style,
            }) ? 1 : 0),
        },
        ImageList_DrawIndirect: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([params])=>{
                if ((params >>> 0) === 0 || !host.readMemory)
                {
                    return 0;
                }
                const bytes = host.readMemory(params >>> 0, IMAGELISTDRAWPARAMS.V3_SIZE);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                /** @param {number} at */
                const field = at=>view.getInt32(at, true);
                if ((field(IMAGELISTDRAWPARAMS.cbSize) >>> 0) < IMAGELISTDRAWPARAMS.V3_SIZE)
                {
                    return 0;
                }
                return drawImage({
                    handle: field(IMAGELISTDRAWPARAMS.himl),
                    index: field(IMAGELISTDRAWPARAMS.i),
                    hdc: field(IMAGELISTDRAWPARAMS.hdcDst),
                    x: field(IMAGELISTDRAWPARAMS.x),
                    y: field(IMAGELISTDRAWPARAMS.y),
                    cx: field(IMAGELISTDRAWPARAMS.cx),
                    cy: field(IMAGELISTDRAWPARAMS.cy),
                    xBitmap: field(IMAGELISTDRAWPARAMS.xBitmap),
                    yBitmap: field(IMAGELISTDRAWPARAMS.yBitmap),
                    background: field(IMAGELISTDRAWPARAMS.rgbBk) >>> 0,
                    style: field(IMAGELISTDRAWPARAMS.fStyle),
                    rop: field(IMAGELISTDRAWPARAMS.dwRop) >>> 0,
                }) ? 1 : 0;
            },
        },

        /**
         * BOOL ImageList_GetImageInfo(HIMAGELIST, int i, IMAGEINFO *)
         *
         * The list's own bitmap and mask, and where in them the image is.
         */
        ImageList_GetImageInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: (args = [])=>{
                const [handle, index, info] = args;
                const list = listOf(handle ?? 0);
                if (!list || (index | 0) < 0 || (index | 0) >= list.count
                    || (info >>> 0) === 0 || list.image === 0)
                {
                    return 0;
                }
                const left = (index | 0) * list.cx;
                host.writeMemory(info >>> 0, dwords([list.image, list.mask, 0, 0,
                    left, 0, left + list.cx, list.cy]));
                return 1;
            },
        },
    };

    return {
        functions,
        /** @param {number} handle @returns {{ cx: number, cy: number } | null} */
        size: handle=>{
            const list = listOf(handle);
            return list ? { cx: list.cx, cy: list.cy } : null;
        },
        /**
         * @param {number} handle @param {number} index @param {number} hdc
         * @param {number} x @param {number} y
         */
        draw: (handle, index, hdc, x, y)=>drawImage({
            handle, index, hdc, x, y, style: ILD_TRANSPARENT,
        }),
    };
}
