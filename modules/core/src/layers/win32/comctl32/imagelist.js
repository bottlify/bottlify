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
 *
 * How many images the bitmaps have room for is kept as Windows keeps it,
 * because ImageList_Write records it and sizes the bitmaps it writes by it
 * (Wine's test_imagelist_storage reads both back): one more than cInitial
 * at first, and when an addition would fill it, as many more as were added
 * or cGrow -- rounded up to a multiple of four -- whichever is more, plus one.
 */

/** ImageList_Add and friends report failure with this, not with zero. */
const FAILED = -1;

/** ImageList_Create's flag for a list with a mask, and the bits that say its depth. */
const ILC_MASK = 0x0001;
const ILC_COLORMASK = 0x00fe;
const ILC_COLOR4 = 0x0004;
const ILC_COLOR24 = 0x0018;

/**
 * How many overlay masks a list has (MSDN: fifteen since 4.71), and how many
 * of them ILHEAD records, its ovls being four words.
 */
const MAX_OVERLAYS = 15;
const SAVED_OVERLAYS = 4;

/** No overlay image is set, as a list starts. */
const NO_OVERLAYS = Object.freeze(Array(MAX_OVERLAYS).fill(-1));

/** The bits of a drawing style that name an overlay, one-based. */
const ILD_OVERLAYMASK = 0x0f00;

/** The depths a list's image is written at; any other -- ILC_COLORDDB -- is 32. */
const DIB_DEPTHS = new Set([4, 8, 16, 24, 32]);
const BITMAPINFOHEADER_SIZE = 40;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

/** LoadImage's type for a bitmap. */
const IMAGE_BITMAP = 0;

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
const WHITENESS = 0x00ff0062;
const PSDPXAX = 0x00b8074a;

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
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [user32]
 *           user32's exports, which a list made out of a module's bitmap
 *           resource loads it with.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {ReturnType<typeof createImageLists>} [imageLists]  The lists to
 *           export, when the host built them itself to share with the
 *           controls that draw from them.
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 *           Guest memory, which a list written to or read from a stream
 *           passes through: gdi32 exchanges a bitmap's bits only there.
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>}
 *     [call]  Guest code called, which a stream's own methods are.
 * @property {() => unknown} [callerThread]
 */

/**
 * The fields of a list ILHEAD carries.
 *
 * @typedef {Object} ListFields
 * @property {number} cx @property {number} cy @property {number} flags
 * @property {number} count @property {number} max @property {number} grow
 * @property {number} background
 * @property {readonly number[]} overlays
 */

/**
 * A device-independent bitmap: its BITMAPINFOHEADER and colour table, and
 * its bits.
 *
 * @typedef {Object} Dib
 * @property {Uint8Array} info @property {Uint8Array} bits
 */

/**
 * Guest memory to pass a bitmap's bits to and from gdi32 in.
 *
 * @typedef {Object} Scratch
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} release
 */

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
     * @property {number} max       How many its bitmaps have room for: cMaxImage.
     * @property {number} initial   cInitial, which SetIconSize starts it over from.
     * @property {number} grow      cGrow, at least one and rounded up to a multiple of four.
     * @property {number} image     The bitmap every image sits in, side by side.
     * @property {number} mask      Its monochrome mask, or 0 without ILC_MASK.
     * @property {number} background  What ILD_NORMAL fills behind the image.
     * @property {readonly number[]} overlays  The images the fifteen overlays are, or -1.
     */

    /** @type {Map<number, ImageList>} */
    const lists = new Map();
    let nextHandle = 0x2000;

    /** What a drag in progress has been told, and reads back. */
    /**
     * `owned` is the list a cursor image was merged into the dragged one in,
     * which the drag holds and lets go of.
     */
    let drag = { list: 0, image: 0, dx: 0, dy: 0, window: 0, x: 0, y: 0, shown: true, owned: 0 };
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
     * Gives the list's bitmaps room for `max` images, the first `keep` of
     * those it had carried over. False, and the list as it was, when the
     * bitmaps cannot be made that large.
     *
     * @param {ImageList} list @param {number} max @param {number} keep
     * @returns {boolean}
     */
    const resize = (list, max, keep)=>{
        if (!host.gdi32)
        {
            list.max = max;
            return true;
        }
        const width = list.cx * max;
        const masked = (list.flags & ILC_MASK) !== 0;
        const image = gdi('CreateBitmap', width, list.cy, 1, 32, 0);
        const mask = masked ? gdi('CreateBitmap', width, list.cy, 1, 1, 0) : 0;
        if (image === 0 || (masked && mask === 0))
        {
            [image, mask].filter(bitmap=>bitmap !== 0)
                .forEach(bitmap=>gdi('DeleteObject', bitmap));
            return false;
        }
        /** @type {[number, number][]} */
        const pairs = [[list.image, image], [list.mask, mask]];
        for (const [from, to] of pairs)
        {
            if (from !== 0 && to !== 0 && keep > 0)
            {
                withDCs([to, from], (target, source)=>gdi('BitBlt', target, 0, 0,
                    list.cx * keep, list.cy, source, 0, 0, SRCCOPY));
            }
            if (from !== 0)
            {
                gdi('DeleteObject', from);
            }
        }
        Object.assign(list, { image, mask, max });
        return true;
    };

    /**
     * Makes room for `adding` more images, as Windows grows a list: not at
     * all while one place stays free after them, and otherwise by as many
     * as are added or by cGrow, whichever is more, and one besides.
     *
     * @param {ImageList} list @param {number} adding
     * @returns {boolean} false when the bitmaps could not grow
     */
    const makeRoom = (list, adding)=>list.count + adding < list.max
        || resize(list, list.max + Math.max(adding, list.grow) + 1, list.count);

    /**
     * A list as ImageList_Create makes one, or as ImageList_Read restores
     * one with the room its stream says it had; zero when its bitmaps
     * cannot be made.
     *
     * A list made with ILC_COLOR is a 4-bit list from the start: it is
     * written so, and Wine's test_imagelist_storage reads it back so.
     *
     * @param {number} cx @param {number} cy @param {number} flags
     * @param {number} initial @param {number} grow @param {number} [max]
     * @returns {number} its handle
     */
    const makeList = (cx, cy, flags, initial, grow, max = initial + 1)=>{
        const colour = (flags & ILC_COLORMASK) === 0 ? ILC_COLOR4 : 0;
        /** @type {ImageList} */
        const list = {
            cx, cy, flags: (flags | colour) >>> 0, count: 0, max: 0, initial,
            // A WORD, as it is kept and written.
            grow: (Math.max(grow, 1) + 3) & 0xfffc,
            image: 0, mask: 0, background: CLR_NONE, overlays: NO_OVERLAYS,
        };
        if (!resize(list, max, 0))
        {
            return 0;
        }
        const handle = nextHandle++;
        lists.set(handle, list);
        return handle;
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
        if (!makeRoom(list, count))
        {
            return FAILED;
        }
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
        drawOverlay(list, request);
        return true;
    };

    /**
     * The overlay a style names drawn over the image, through its own mask,
     * when the list has one set for it.
     *
     * @param {ImageList} list @param {DrawRequest} request
     */
    const drawOverlay = (list, request)=>{
        const overlay = ((request.style >>> 0) & ILD_OVERLAYMASK) >>> 8;
        const image = overlay === 0 ? -1 : list.overlays[overlay - 1] ?? -1;
        if (image >= 0 && image < list.count)
        {
            drawImage({ ...request, index: image, style: ILD_TRANSPARENT, background: CLR_NONE });
        }
    };

    /**
     * One image laid into a merged list's only place at (x, y): its mask
     * ANDed into the merged mask, so a pixel either image covers is opaque,
     * and its pixels put where it is opaque. An index the list does not have
     * lays nothing, and the merge still succeeds (Wine's test_merge).
     *
     * @param {ImageList} into @param {ImageList} from @param {number} index
     * @param {number} x @param {number} y
     */
    const lay = (into, from, index, x, y)=>{
        if (index < 0 || index >= from.count || from.image === 0)
        {
            return;
        }
        const left = index * from.cx;
        if (from.mask !== 0)
        {
            // Out of monochrome a 1 -- transparent -- is a new DC's white, so
            // ANDing the mask clears exactly where the image is opaque.
            withDCs([into.mask, from.mask], (target, source)=>gdi('BitBlt', target, x, y,
                from.cx, from.cy, source, left, 0, SRCAND));
            withDCs([into.image, from.mask], (target, source)=>gdi('BitBlt', target, x, y,
                from.cx, from.cy, source, left, 0, SRCAND));
        }
        else
        {
            withDCs([into.mask], target=>gdi('PatBlt', target, x, y, from.cx, from.cy,
                BLACKNESS));
            withDCs([into.image], target=>gdi('PatBlt', target, x, y, from.cx, from.cy,
                BLACKNESS));
        }
        // A list's image is black where it is transparent, so ORing it in
        // leaves what is under its transparent part alone.
        withDCs([into.image, from.image], (target, source)=>gdi('BitBlt', target, x, y,
            from.cx, from.cy, source, left, 0, SRCPAINT));
    };

    /**
     * ImageList_Merge's list: one image, large enough for both, the second
     * offset by (dx, dy) from the first and drawn over it, at the deeper of
     * the two lists' depths and always with a mask.
     *
     * @param {number} first @param {number} firstIndex
     * @param {number} second @param {number} secondIndex
     * @param {number} dx @param {number} dy
     * @returns {number} its handle, or zero
     */
    const merge = (first, firstIndex, second, secondIndex, dx, dy)=>{
        const a = listOf(first);
        const b = listOf(second);
        if (!a || !b)
        {
            return 0;
        }
        const [x1, y1] = [Math.max(0, -dx), Math.max(0, -dy)];
        const [x2, y2] = [Math.max(0, dx), Math.max(0, dy)];
        const depth = Math.max(a.flags & ILC_COLORMASK, b.flags & ILC_COLORMASK);
        const handle = makeList(Math.max(x1 + a.cx, x2 + b.cx), Math.max(y1 + a.cy, y2 + b.cy),
            ILC_MASK | depth, 1, 1);
        const list = listOf(handle);
        if (!list)
        {
            return 0;
        }
        list.count = 1;
        if (host.gdi32 && list.image !== 0)
        {
            const width = list.cx * list.max;
            withDCs([list.image], target=>gdi('PatBlt', target, 0, 0, width, list.cy, BLACKNESS));
            withDCs([list.mask], target=>gdi('PatBlt', target, 0, 0, width, list.cy, WHITENESS));
            lay(list, a, firstIndex, x1, y1);
            lay(list, b, secondIndex, x2, y2);
        }
        return handle;
    };

    /** The list a drag merged a cursor image into, let go of with the drag. */
    const letGo = ()=>{
        if (drag.owned !== 0)
        {
            functions.ImageList_Destroy.handler([drag.owned]);
            drag = { ...drag, owned: 0 };
        }
    };

    /**
     * ImageList_LoadImageA and W: one body, user32's LoadImage in the
     * spelling the name was given in.
     *
     * @param {'LoadImageA' | 'LoadImageW'} loader
     */
    const loadImage = loader=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [instance, name, cx, grow, key, type, flags])=>{
            if ((type >>> 0) !== IMAGE_BITMAP)
            {
                host.divergence?.(`ImageList_${loader}`,
                    `an image list of type ${type >>> 0} is not loaded: only a bitmap's`);
                return 0;
            }
            const bitmap = (host.user32?.(loader)
                ?.handler([instance, name, IMAGE_BITMAP, 0, 0, flags]) ?? 0) >>> 0;
            const size = bitmap === 0 ? null : host.bitmapSize?.(bitmap) ?? null;
            if (!size || size.height <= 0)
            {
                if (bitmap !== 0)
                {
                    gdi('DeleteObject', bitmap);
                }
                return 0;
            }
            const width = (cx | 0) > 0 ? cx | 0 : size.height;
            const masked = (key >>> 0) !== CLR_NONE;
            const handle = functions.ImageList_Create.handler([width, size.height,
                ILC_COLOR24 | (masked ? ILC_MASK : 0),
                Math.max(1, Math.floor(size.width / width)), grow]);
            if (handle !== 0)
            {
                add(handle, bitmap, 0, masked ? key >>> 0 : null);
            }
            gdi('DeleteObject', bitmap);
            return handle;
        },
    });

    const functions = {
        /**
         * HIMAGELIST ImageList_Create(int cx, int cy, UINT flags, int cInitial,
         *                             int cGrow)
         */
        ImageList_Create: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([cx, cy, flags, initial, grow])=>{
                if ((cx | 0) <= 0 || (cy | 0) <= 0)
                {
                    return 0;
                }
                return makeList(cx | 0, cy | 0, flags >>> 0, Math.max(initial | 0, 0), grow | 0);
            },
        },

        /**
         * HIMAGELIST ImageList_LoadImageA(HINSTANCE hi, LPCSTR lpbmp, int cx,
         *     int cGrow, COLORREF crMask, UINT uType, UINT uFlags)
         *
         * A bitmap resource cut into images cx wide -- as wide as it is high
         * for a cx of 0 -- and masked where it is the colour named, unless that
         * is CLR_NONE. The bitmap is loaded and let go of; the list keeps its
         * copy. An icon or a cursor resource is not loaded.
         */
        ImageList_LoadImageA: loadImage('LoadImageA'),
        /**
         * HIMAGELIST ImageList_LoadImageW(HINSTANCE hi, LPCWSTR lpbmp, int cx,
         *     int cGrow, COLORREF crMask, UINT uType, UINT uFlags)
         */
        ImageList_LoadImageW: loadImage('LoadImageW'),

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
                if (!makeRoom(list, 1))
                {
                    return -1;
                }
                list.count++;
                return list.count - 1;
            },
        },

        /**
         * BOOL ImageList_Remove(HIMAGELIST himl, int i)
         *
         * The images after it move down one; -1 removes them all, and leaves
         * room for cGrow (Wine's test_imagelist_storage).
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
                    resize(list, list.grow, 0);
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
         * BOOL ImageList_SetIconSize(HIMAGELIST himl, int cx, int cy)
         *
         * A new image size empties the list -- no image is cut or stretched
         * to fit -- and it starts over with the room it was made with and no
         * overlays. A size of nothing is refused, as ImageList_Create refuses
         * it, and so is one too large for its bitmaps; either leaves the list
         * as it was.
         */
        ImageList_SetIconSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, cx, cy])=>{
                const list = listOf(handle);
                if (!list || (cx | 0) <= 0 || (cy | 0) <= 0)
                {
                    return 0;
                }
                const before = { cx: list.cx, cy: list.cy };
                Object.assign(list, { cx: cx | 0, cy: cy | 0 });
                if (!resize(list, list.initial + 1, 0))
                {
                    Object.assign(list, before);
                    return 0;
                }
                Object.assign(list, { count: 0, overlays: NO_OVERLAYS });
                return 1;
            },
        },

        /**
         * BOOL ImageList_SetImageCount(HIMAGELIST himl, UINT uNewCount)
         *
         * The list is cut to that many images or grown to it, and keeps room
         * for one more (Wine's test_imagelist_storage). The images it keeps
         * are its first; the places it gains are blank until the program
         * replaces them, as it is documented to.
         */
        ImageList_SetImageCount: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, count])=>{
                const list = listOf(handle);
                const wanted = count >>> 0;
                if (!list || !resize(list, wanted + 1, Math.min(list.count, wanted)))
                {
                    return 0;
                }
                list.count = wanted;
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
                letGo();
                drag = {
                    list: handle >>> 0, image: track | 0, dx: dx | 0, dy: dy | 0,
                    window: 0, x: 0, y: 0, shown: true, owned: 0,
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
                letGo();
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
                return drag.owned || drag.list;
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
         * HIMAGELIST ImageList_Merge(HIMAGELIST himl1, int i1, HIMAGELIST himl2,
         *                            int i2, int dx, int dy)
         *
         * A new list of one image: the second drawn over the first at
         * (dx, dy) from it, as large as both together. An image either list
         * does not have is left out rather than refused (Wine's test_merge);
         * only a list that is not one fails.
         */
        ImageList_Merge: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([first, firstIndex, second, secondIndex, dx, dy])=>merge(first,
                firstIndex | 0, second, secondIndex | 0, dx | 0, dy | 0),
        },

        /**
         * BOOL ImageList_SetDragCursorImage(HIMAGELIST himlDrag, int iDrag,
         *                                   int dxHotspot, int dyHotspot)
         *
         * The image being dragged, with a cursor's image merged over it at
         * the offset given: the drag's image becomes that merged list, as
         * large as both, and its hot spot stays where BeginDrag put it (Wine's
         * test_hotspot). Each call merges from the image the drag began with,
         * so a cursor that changes does not pile up. No drag is FALSE.
         */
        ImageList_SetDragCursorImage: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([cursor, index, dx, dy])=>{
                if (!dragging)
                {
                    return 0;
                }
                const merged = merge(drag.list, drag.image, cursor, index | 0, dx | 0, dy | 0);
                if (merged === 0)
                {
                    return 0;
                }
                letGo();
                drag = { ...drag, owned: merged };
                return 1;
            },
        },

        /**
         * BOOL ImageList_SetOverlayImage(HIMAGELIST himl, int iImage, int iOverlay)
         *
         * Names an image as one of the list's fifteen overlay masks, which a
         * drawing style picks with INDEXTOOVERLAYMASK and draws over the image
         * through its own mask; -1 clears it. An overlay out of 1..15, or an
         * image the list does not have, is refused.
         */
        ImageList_SetOverlayImage: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, image, overlay])=>{
                const list = listOf(handle);
                const at = overlay | 0;
                const index = image | 0;
                if (!list || at < 1 || at > MAX_OVERLAYS || index < -1 || index >= list.count)
                {
                    return 0;
                }
                list.overlays = list.overlays.map((held, slot)=>(slot === at - 1 ? index : held));
                return 1;
            },
        },

        /**
         * HIMAGELIST ImageList_Duplicate(HIMAGELIST himl)
         *
         * A list of its own with the same images, room, growth, background and
         * overlays.
         */
        ImageList_Duplicate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const list = listOf(handle);
                if (!list)
                {
                    return 0;
                }
                const copy = makeList(list.cx, list.cy, list.flags, list.initial, list.grow,
                    list.max);
                const made = listOf(copy);
                if (!made)
                {
                    return 0;
                }
                Object.assign(made, { count: list.count, background: list.background,
                    overlays: [...list.overlays] });
                /** @type {[number, number][]} */
                const pairs = [[made.image, list.image], [made.mask, list.mask]];
                for (const [to, from] of pairs.filter(([a, b])=>a !== 0 && b !== 0))
                {
                    withDCs([to, from], (target, source)=>gdi('BitBlt', target, 0, 0,
                        list.cx * list.max, list.cy, source, 0, 0, SRCCOPY));
                }
                return copy;
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

    /**
     * An image as a disabled toolbar button shows it, embossed: its dark
     * pixels -- every one neither the face colour nor the highlight, and not
     * transparent -- drawn in the highlight a pixel down and to the right,
     * and in the shadow over that.
     *
     * @param {number} handle @param {number} index @param {number} hdc
     * @param {number} x @param {number} y
     * @param {{ face: number, light: number, shadow: number }} colors
     * @returns {boolean} false for no list, no such image or no DC
     */
    const drawEmbossed = (handle, index, hdc, x, y, colors)=>{
        const list = listOf(handle);
        if (!list || !host.gdi32 || list.image === 0 || (index | 0) < 0
            || (index | 0) >= list.count || (hdc >>> 0) === 0)
        {
            return false;
        }
        const from = (index | 0) * list.cx;
        // Into monochrome a colour source is 1 where it is its background
        // colour: the face, then the highlight, then the transparent part.
        const shape = gdi('CreateBitmap', list.cx, list.cy, 1, 1, 0);
        withDCs([shape, list.image], (target, source)=>{
            gdi('SetBkColor', source, colors.face);
            gdi('BitBlt', target, 0, 0, list.cx, list.cy, source, from, 0, SRCCOPY);
            gdi('SetBkColor', source, colors.light);
            gdi('BitBlt', target, 0, 0, list.cx, list.cy, source, from, 0, SRCPAINT);
        });
        if (list.mask !== 0)
        {
            withDCs([shape, list.mask], (target, source)=>gdi('BitBlt', target, 0, 0, list.cx,
                list.cy, source, from, 0, SRCPAINT));
        }
        // Out of monochrome a 0 is the text colour: black, so PSDPxax puts the
        // brush where the shape is 0 and leaves the rest.
        const text = gdi('SetTextColor', hdc, 0x000000);
        const back = gdi('SetBkColor', hdc, 0xffffff);
        withDCs([shape], source=>{
            for (const [offset, rgb] of [[1, colors.light], [0, colors.shadow]])
            {
                const brush = gdi('CreateSolidBrush', rgb);
                const previous = gdi('SelectObject', hdc, brush);
                gdi('BitBlt', hdc, x + offset, y + offset, list.cx, list.cy, source, 0, 0,
                    PSDPXAX);
                gdi('SelectObject', hdc, previous);
                gdi('DeleteObject', brush);
            }
        });
        gdi('SetTextColor', hdc, text);
        gdi('SetBkColor', hdc, back);
        gdi('DeleteObject', shape);
        return true;
    };

    /**
     * One of a list's bitmaps as a DIB of `columns` images a row, room for
     * every place the list has, read out through gdi32 at `depth` bits a
     * pixel; null when there is no guest memory for it. A build without
     * gdi32 has no pixels to give, and gives a blank DIB of the same shape.
     *
     * @param {ImageList} list @param {number} source @param {number} depth
     * @param {number} columns @param {Scratch} scratch
     * @returns {Dib | null}
     */
    const saveDib = (list, source, depth, columns, scratch)=>{
        const width = list.cx * columns;
        const height = list.cy * Math.ceil(list.max / columns);
        const stride = ((width * depth + 31) >>> 5) * 4;
        const infoSize = BITMAPINFOHEADER_SIZE + (depth <= 8 ? (1 << depth) * 4 : 0);
        const total = infoSize + stride * height;
        const read = host.readMemory;
        const block = read ? scratch.allocate(total) : 0;
        if (!read || block === 0)
        {
            return null;
        }
        try
        {
            const laid = new Uint8Array(total);
            const header = new DataView(laid.buffer, 0, BITMAPINFOHEADER_SIZE);
            header.setUint32(0, BITMAPINFOHEADER_SIZE, true);
            header.setInt32(4, width, true);
            header.setInt32(8, height, true);
            header.setUint16(12, 1, true);
            header.setUint16(14, depth, true);
            header.setUint32(16, BI_RGB, true);
            header.setUint32(20, stride * height, true);
            host.writeMemory(block, laid);
            if (host.gdi32 && source !== 0)
            {
                const grid = gdi('CreateBitmap', width, height, 1, depth === 1 ? 1 : 32, 0);
                withDCs([grid, source], (target, from)=>{
                    for (let index = 0; index < list.count; index++)
                    {
                        gdi('BitBlt', target, (index % columns) * list.cx,
                            Math.floor(index / columns) * list.cy, list.cx, list.cy, from,
                            index * list.cx, 0, SRCCOPY);
                    }
                });
                const dc = gdi('CreateCompatibleDC', 0);
                gdi('GetDIBits', dc, grid, 0, height, block + infoSize, block, DIB_RGB_COLORS);
                gdi('DeleteDC', dc);
                gdi('DeleteObject', grid);
            }
            const bytes = read(block, total);
            return { info: bytes.slice(0, infoSize), bits: bytes.slice(infoSize) };
        }
        finally
        {
            scratch.release(block);
        }
    };

    /**
     * A DIB of images laid `columns` a row put into one of a list's bitmaps,
     * a strip, as many images as the list counts. The columns are as many
     * as the DIB is wide for. False when there is no guest memory for it.
     *
     * @param {ImageList} list @param {number} target @param {Dib} dib
     * @param {Scratch} scratch
     * @returns {boolean}
     */
    const restoreDib = (list, target, dib, scratch)=>{
        if (!host.gdi32 || target === 0)
        {
            return true;
        }
        const header = new DataView(dib.info.buffer, dib.info.byteOffset, dib.info.byteLength);
        const width = header.getInt32(4, true);
        const height = Math.abs(header.getInt32(8, true));
        const block = scratch.allocate(dib.info.length + dib.bits.length);
        if (block === 0)
        {
            return false;
        }
        host.writeMemory(block, dib.info);
        host.writeMemory(block + dib.info.length, dib.bits);
        const grid = gdi('CreateBitmap', width, height, 1, target === list.mask ? 1 : 32, 0);
        const dc = gdi('CreateCompatibleDC', 0);
        gdi('SetDIBits', dc, grid, 0, height, block + dib.info.length, block, DIB_RGB_COLORS);
        gdi('DeleteDC', dc);
        scratch.release(block);
        const columns = Math.max(1, Math.floor(width / list.cx));
        withDCs([target, grid], (into, from)=>{
            for (let index = 0; index < list.count; index++)
            {
                gdi('BitBlt', into, index * list.cx, 0, list.cx, list.cy, from,
                    (index % columns) * list.cx, Math.floor(index / columns) * list.cy, SRCCOPY);
            }
        });
        gdi('DeleteObject', grid);
        return true;
    };

    return {
        functions,
        drawEmbossed,
        /**
         * One image as an icon is made of: its colour bits as a 32-bit
         * device-dependent bitmap's, rows top first, and its mask's, each row
         * padded to a WORD -- black where the mask is set, as an icon's XOR
         * plane is. A list without a mask is opaque throughout. Null for no
         * list, no such image, no gdi32, or no guest memory to read through.
         *
         * @param {number} handle @param {number} index @param {Scratch} scratch
         * @returns {{ cx: number, cy: number, and: Uint8Array, xor: Uint8Array } | null}
         */
        iconPlanes: (handle, index, scratch)=>{
            const list = listOf(handle);
            const read = host.readMemory;
            if (!list || !host.gdi32 || !read || list.image === 0 || (index | 0) < 0
                || (index | 0) >= list.count)
            {
                return null;
            }
            const { cx, cy } = list;
            const colourSize = cx * 4 * cy;
            const maskSize = ((cx + 15) >>> 4) * 2 * cy;
            const block = scratch.allocate(colourSize + maskSize);
            if (block === 0)
            {
                return null;
            }
            try
            {
                /** @param {number} source @param {number} depth @param {number} size @param {number} at */
                const planeOf = (source, depth, size, at)=>{
                    const bitmap = gdi('CreateBitmap', cx, cy, 1, depth, 0);
                    withDCs([bitmap, source], (target, from)=>gdi('BitBlt', target, 0, 0, cx, cy,
                        from, (index | 0) * cx, 0, SRCCOPY));
                    gdi('GetBitmapBits', bitmap, size, at);
                    gdi('DeleteObject', bitmap);
                    return read(at, size).slice();
                };
                return {
                    cx, cy,
                    xor: planeOf(list.image, 32, colourSize, block),
                    and: list.mask !== 0 ? planeOf(list.mask, 1, maskSize, block + colourSize)
                        : new Uint8Array(maskSize),
                };
            }
            finally
            {
                scratch.release(block);
            }
        },
        /**
         * A list as ImageList_Write records it: the fields of its header,
         * and its image and mask as DIBs of `columns` images a row, the image
         * at the depth the list was made with. Null for no list, or no guest
         * memory to read its bitmaps through.
         *
         * @param {number} handle @param {number} columns @param {Scratch} scratch
         * @returns {{ fields: ListFields, image: Dib, mask: Dib | null } | null}
         */
        save: (handle, columns, scratch)=>{
            const list = listOf(handle);
            if (!list)
            {
                return null;
            }
            const declared = list.flags & ILC_COLORMASK;
            const image = saveDib(list, list.image, DIB_DEPTHS.has(declared) ? declared : 32,
                columns, scratch);
            const mask = (list.flags & ILC_MASK) !== 0
                ? saveDib(list, list.mask, 1, columns, scratch)
                : null;
            if (!image || ((list.flags & ILC_MASK) !== 0 && !mask))
            {
                return null;
            }
            const { cx, cy, flags, count, max, grow, background, overlays } = list;
            const saved = overlays.slice(0, SAVED_OVERLAYS);
            return { fields: { cx, cy, flags, count, max, grow, background, overlays: saved },
                image, mask };
        },
        /**
         * A list made again from what `save` recorded, with the room its
         * header says it had; zero when it cannot be made.
         *
         * @param {ListFields} fields @param {Dib} image @param {Dib | null} mask
         * @param {Scratch} scratch
         * @returns {number} its handle
         */
        restore: (fields, image, mask, scratch)=>{
            if (fields.cx <= 0 || fields.cy <= 0)
            {
                return 0;
            }
            const handle = makeList(fields.cx, fields.cy, fields.flags, fields.count, fields.grow,
                Math.max(fields.max, fields.count + 1));
            const list = listOf(handle);
            if (!list)
            {
                return 0;
            }
            Object.assign(list, { count: fields.count, background: fields.background >>> 0,
                overlays: [...NO_OVERLAYS].map((none, at)=>fields.overlays[at] ?? none) });
            if (!restoreDib(list, list.image, image, scratch)
                || (mask !== null && !restoreDib(list, list.mask, mask, scratch)))
            {
                functions.ImageList_Destroy.handler([handle]);
                return 0;
            }
            return handle;
        },
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
