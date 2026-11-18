/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rebar, `ReBarWindow32`.
 *
 * Bands in rows, each a header - the gripper a band is dragged by when there
 * is more than one, an image, a title - and a child window beside it, the
 * band as long as REBARBANDINFO's cx asks and never shorter than its header,
 * its child's least width and the four pixels after the child. Bands fill a
 * row while their least lengths fit, then start the next; RBBS_BREAK starts
 * one. A row too short takes from the last band backwards, down to each
 * one's least; a row with room left gives it to its last band.
 * RB_MAXIMIZEBAND and RB_MINIMIZEBAND move length between the bands of a
 * row and make it what those bands ask for from then on.
 *
 * Unless CCS_NORESIZE, the bar places itself: as long as its parent along
 * its edge (the top, the bottom with CCS_BOTTOM, left and right with
 * CCS_VERT), two pixels in from a top or left edge for the divider unless
 * CCS_NODIVIDER, and as thick as its rows; CCS_NOMOVEY keeps where it is
 * across, CCS_NOPARENTALIGN keeps its place and length and sets only its
 * thickness. When its thickness changes it tells the parent RBN_HEIGHTCHANGE.
 * Vertically the same layout is turned: a band's rectangle reads along the
 * bar first, as RB_GETRECT reports it.
 *
 * The geometry follows what a real comctl32 answers in Wine's rebar test
 * (test_layout, test_resize, test_bandinfo, test_chevron); MSDN names the
 * messages and the structures.
 *
 * What is not here: dragging bands with the mouse, the chevron's own
 * button, background bitmaps, tooltips and RBS_DBLCLKTOGGLE.
 */

import {
    WM_CREATE, WM_PAINT, WM_SETFONT, WM_COMMAND,
    COLOR_3DFACE, COLOR_3DHILIGHT, COLOR_3DSHADOW, COLOR_BTNTEXT,
    after,
} from '../user32/controls.js';
import { notifyWindow } from './notify.js';
import { readText, writeText } from './strings.js';
import { CCM_GETVERSION, CCM_SETVERSION, answerVersion } from './version.js';

/** The class name a program creates the control by. */
export const REBAR_CLASS = 'ReBarWindow32';

/** The atom spacing a build without a bridge gives the class's procedure. */
export const REBAR_ATOM = 0x801b;

/** The bar's styles, the common controls' beside its own. */
export const CCS_TOP = 0x0001;
export const CCS_NOMOVEY = 0x0002;
export const CCS_BOTTOM = 0x0003;
export const CCS_NORESIZE = 0x0004;
export const CCS_NOPARENTALIGN = 0x0008;
export const CCS_NODIVIDER = 0x0040;
export const CCS_VERT = 0x0080;
export const RBS_VARHEIGHT = 0x0200;
export const RBS_BANDBORDERS = 0x0400;
export const RBS_AUTOSIZE = 0x2000;

/** A band's styles. */
export const RBBS_BREAK = 0x0001;
export const RBBS_FIXEDSIZE = 0x0002;
export const RBBS_CHILDEDGE = 0x0004;
export const RBBS_HIDDEN = 0x0008;
export const RBBS_VARIABLEHEIGHT = 0x0040;
export const RBBS_GRIPPERALWAYS = 0x0080;
export const RBBS_NOGRIPPER = 0x0100;
export const RBBS_USECHEVRON = 0x0200;
export const RBBS_HIDETITLE = 0x0400;
/**
 * What RB_GETBANDINFO's fStyle adds for a band whose header RBBIM_HEADERSIZE
 * fixed: the real control reports it (Wine's rebar test, test_bandinfo), and
 * setting the style again lets the header be measured once more.
 */
const RBBS_FIXEDHEADER = 0x40000000;

/** What a REBARBANDINFO's fMask says it carries. */
export const RBBIM_STYLE = 0x0001;
export const RBBIM_COLORS = 0x0002;
export const RBBIM_TEXT = 0x0004;
export const RBBIM_IMAGE = 0x0008;
export const RBBIM_CHILD = 0x0010;
export const RBBIM_CHILDSIZE = 0x0020;
export const RBBIM_SIZE = 0x0040;
export const RBBIM_BACKGROUND = 0x0080;
export const RBBIM_ID = 0x0100;
export const RBBIM_IDEALSIZE = 0x0200;
export const RBBIM_LPARAM = 0x0400;
export const RBBIM_HEADERSIZE = 0x0800;

/** Messages, numbered off WM_USER as the header numbers them. */
const WM_USER = 0x0400;
export const RB_INSERTBANDA = WM_USER + 1;
export const RB_DELETEBAND = WM_USER + 2;
export const RB_GETBARINFO = WM_USER + 3;
export const RB_SETBARINFO = WM_USER + 4;
const RB_GETBANDINFO_OLD = WM_USER + 5;
export const RB_SETBANDINFOA = WM_USER + 6;
export const RB_SETPARENT = WM_USER + 7;
export const RB_HITTEST = WM_USER + 8;
export const RB_GETRECT = WM_USER + 9;
export const RB_INSERTBANDW = WM_USER + 10;
export const RB_SETBANDINFOW = WM_USER + 11;
export const RB_GETBANDCOUNT = WM_USER + 12;
export const RB_GETROWCOUNT = WM_USER + 13;
export const RB_GETROWHEIGHT = WM_USER + 14;
export const RB_IDTOINDEX = WM_USER + 16;
export const RB_GETTOOLTIPS = WM_USER + 17;
export const RB_SETTOOLTIPS = WM_USER + 18;
export const RB_SETBKCOLOR = WM_USER + 19;
export const RB_GETBKCOLOR = WM_USER + 20;
export const RB_SETTEXTCOLOR = WM_USER + 21;
export const RB_GETTEXTCOLOR = WM_USER + 22;
export const RB_GETBARHEIGHT = WM_USER + 27;
export const RB_GETBANDINFOW = WM_USER + 28;
export const RB_GETBANDINFOA = WM_USER + 29;
export const RB_MINIMIZEBAND = WM_USER + 30;
export const RB_MAXIMIZEBAND = WM_USER + 31;
export const RB_GETBANDBORDERS = WM_USER + 34;
export const RB_SHOWBAND = WM_USER + 35;
export const RB_SETPALETTE = WM_USER + 37;
export const RB_GETPALETTE = WM_USER + 38;
export const RB_MOVEBAND = WM_USER + 39;
export const RB_SETEXTENDEDSTYLE = WM_USER + 41;
export const RB_GETEXTENDEDSTYLE = WM_USER + 42;
export const RB_PUSHCHEVRON = WM_USER + 43;
export const RB_SETBANDWIDTH = WM_USER + 44;
export const RB_SETCOLORSCHEME = 0x2002;
export const RB_GETCOLORSCHEME = 0x2003;
export const RB_SETUNICODEFORMAT = 0x2005;
export const RB_GETUNICODEFORMAT = 0x2006;

/** What the bar tells its parent: WM_NOTIFY's codes, off RBN_FIRST (-831). */
export const RBN_HEIGHTCHANGE = -831;
export const RBN_CHEVRONPUSHED = -841;

/** Where RB_HITTEST found a point. */
const RBHT_NOWHERE = 0x0001;
const RBHT_CAPTION = 0x0002;
const RBHT_CLIENT = 0x0003;
const RBHT_GRABBER = 0x0004;
const RBHT_CHEVRON = 0x0008;

const WM_SIZE = 0x0005;
const WM_NOTIFY = 0x004e;
const WM_STYLECHANGED = 0x007d;
const WM_NCCALCSIZE = 0x0083;
const WM_DRAWITEM = 0x002b;
const WM_MEASUREITEM = 0x002c;
const WS_BORDER = 0x00800000;
const WS_DLGFRAME = 0x00400000;
const WS_VISIBLE = 0x10000000;
const SW_HIDE = 0;
const SW_SHOW = 5;
const CLR_NONE = 0xffffffff;
const CLR_DEFAULT = 0xff000000;
const RBIM_IMAGELIST = 0x0001;
const DT_LEFT = 0x0000;
const DT_VCENTER = 0x0004;
const DT_SINGLELINE = 0x0020;

/**
 * The measures of a band, as the real control lays them out: the gripper
 * and the two pixels before it, the space after the gripper (or before the
 * title when there is none), after the title and after the child, the
 * least band, a border between bands and between rows with
 * RBS_BANDBORDERS, the edge around a child with RBBS_CHILDEDGE, and the
 * chevron's width.
 */
const GRIPPER = 5;
const AFTER_GRIPPER = 4;
const AFTER_IMAGE = 2;
const AFTER_TEXT = 4;
const AFTER_CHILD = 4;
const LEAST_HEIGHT = 4;
const BAND_BORDER = 2;
const CHILD_EDGE = 2;
const CHEVRON = 13;
/** An edge two pixels wide all round, which is what WS_BORDER gives a rebar. */
const BORDER_EDGE = 2;
const NO_MAXIMUM = 0x7fffffff;

/**
 * Where REBARBANDINFO's fields sit, by the width of a pointer; `v3` and
 * `v6` are the sizes of the shorter versions of the structure a program may
 * hand over (REBARBANDINFO_V3_SIZE, _V6_SIZE).
 *
 * @param {number} pointer
 */
const bandInfoLayout = pointer=>(pointer === 8
    ? { fMask: 4, fStyle: 8, clrFore: 12, clrBack: 16, lpText: 24, cch: 32, iImage: 36,
        hwndChild: 40, cxMinChild: 48, cyMinChild: 52, cx: 56, hbmBack: 64, wID: 72,
        cyChild: 76, cyMaxChild: 80, cyIntegral: 84, cxIdeal: 88, lParam: 96, cxHeader: 104,
        v3: 76, v6: 108 }
    : { fMask: 4, fStyle: 8, clrFore: 12, clrBack: 16, lpText: 20, cch: 24, iImage: 28,
        hwndChild: 32, cxMinChild: 36, cyMinChild: 40, cx: 44, hbmBack: 48, wID: 52,
        cyChild: 56, cyMaxChild: 60, cyIntegral: 64, cxIdeal: 68, lParam: 72, cxHeader: 76,
        v3: 56, v6: 80 });

/**
 * @typedef {import('../user32/controls.js').ControlHost} ControlHost
 * @typedef {import('../user32/controls.js').ControlMessage} ControlMessage
 * @typedef {import('../user32/controls.js').Rect} Rect
 * @typedef {import('./toolbar.js').ToolbarImages} ToolbarImages
 *
 * @typedef {Object} Band
 * @property {number} style @property {number} fore @property {number} back
 * @property {string} text @property {number} image @property {number} child
 * @property {number} cxMinChild @property {number} cyMinChild @property {number} cx
 * @property {number} bitmap @property {number} id
 * @property {number} cyChild @property {number} cyMaxChild @property {number} cyIntegral
 * @property {number} cxIdeal @property {Uint8Array} param
 * @property {number | null} fixedHeader  RBBIM_HEADERSIZE's, until the style is set again.
 * @property {number} header  As last measured.
 * @property {number} least  The shortest the band can be, as last measured.
 * @property {number | null} length  As last laid out; null until it is.
 * @property {number} row
 * @property {number[]} dropped  Children it had before, to be hidden.
 * @property {Rect} rect  Along the bar first, as RB_GETRECT answers.
 */

/**
 * Builds the window procedure of a rebar.
 *
 * @param {ControlHost} host
 * @param {any} tk  The drawing helpers the system classes share.
 * @param {ToolbarImages} [images]  The image lists a band's image is drawn from.
 * @returns {(record: any, message: ControlMessage, thread?: unknown)
 *     => number | Promise<number>}
 */
export function createRebarProcedure(host, tk, images){
    const pointer = host.pointerSize ?? 4;
    const INFO = bandInfoLayout(pointer);

    /**
     * @param {any} record
     * @returns {{ bands: Band[], dropped: number[], rows: { top: number, height: number }[],
     *     thickness: number | null, laidLength: number | null, vertical: boolean,
     *     textColor: number, bkColor: number, list: number, owner: number | null,
     *     tooltips: number, palette: number, extended: number, unicode: boolean,
     *     placing: boolean, version?: number }}
     */
    const state = record=>{
        const held = tk.stateOf(record);
        held.bands ??= [];
        held.dropped ??= [];
        held.rows ??= [];
        held.thickness ??= null;
        held.laidLength ??= null;
        held.vertical ??= false;
        held.textColor ??= CLR_NONE;
        held.bkColor ??= CLR_NONE;
        held.list ??= 0;
        held.owner ??= null;
        held.tooltips ??= 0;
        held.palette ??= 0;
        held.extended ??= 0;
        held.unicode ??= record.unicode === true;
        held.placing ??= false;
        return held;
    };

    /** @param {number} address */
    const u32 = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** A pointer-wide field: a handle or an address, its low half what counts. */
    const setPointer = (/** @type {number} */ address, /** @type {number} */ value)=>{
        setU32(address, value);
        if (pointer === 8)
        {
            setU32(address + 4, 0);
        }
    };
    /** @param {number} address @param {Rect} rect */
    const setRect = (address, rect)=>host.writeMemory(address >>> 0, new Uint8Array(
        new Int32Array([rect.left, rect.top, rect.right, rect.bottom]).buffer));

    /** @param {any} record */
    const ownerOf = record=>state(record).owner ?? notifyWindow(record);

    /** @param {Band} band */
    const visible = band=>(band.style & RBBS_HIDDEN) === 0;

    /**
     * The extents a layout needs in the bar's font: a title's width and the
     * line's height.
     *
     * @param {any} record @param {string[]} texts
     */
    const measure = (record, texts)=>{
        if (!host.draw)
        {
            return { widths: texts.map(()=>0), line: 16 };
        }
        const draw = host.draw;
        const { hdc } = host.contextOn(record);
        const found = hdc === 0 ? { widths: texts.map(()=>0), line: 16 }
            : { widths: texts.map(text=>(text === '' ? 0 : draw.measure(hdc, text).width)),
                line: draw.measure(hdc, 'M').height };
        host.endPaint(record, hdc);
        return found;
    };

    /** @param {any} record @param {Band} band */
    const imageSize = (record, band)=>{
        const list = state(record).list;
        return list !== 0 && band.image !== -1 && images ? images.size(list) : null;
    };

    /** @param {Band} band */
    const titled = band=>band.text !== '' && (band.style & RBBS_HIDETITLE) === 0;

    /**
     * How tall a band's child stands: its least height, or for a band of
     * RBBS_VARIABLEHEIGHT the height it asked for within its least and most,
     * in steps of cyIntegral from the least.
     *
     * @param {Band} band
     */
    const childHeight = band=>{
        if ((band.style & RBBS_VARIABLEHEIGHT) === 0)
        {
            return band.cyMinChild;
        }
        const wanted = Math.max(band.cyMinChild, Math.min(band.cyChild, band.cyMaxChild));
        return band.cyIntegral > 0
            ? band.cyMinChild + Math.floor((wanted - band.cyMinChild) / band.cyIntegral)
                * band.cyIntegral
            : wanted;
    };

    /**
     * Measures every band's header and least length, and how thick each is.
     *
     * @param {any} record
     * @returns {Map<Band, number>} each shown band's thickness
     */
    const measureBands = record=>{
        const held = state(record);
        const shown = held.bands.filter(visible);
        const extents = measure(record, shown.map(band=>(titled(band) ? band.text : '')));
        const grippers = shown.length > 1;
        /** @type {Map<Band, number>} */
        const thickness = new Map();
        shown.forEach((band, at)=>{
            const gripper = (band.style & RBBS_GRIPPERALWAYS) !== 0
                || grippers && (band.style & RBBS_NOGRIPPER) === 0;
            const image = imageSize(record, band);
            const title = titled(band);
            let header = gripper ? GRIPPER : 0;
            if (gripper || image || title)
            {
                header += AFTER_GRIPPER;
            }
            header += image ? image.cx + AFTER_IMAGE : 0;
            header += title ? extents.widths[at] + AFTER_TEXT : 0;
            band.header = band.fixedHeader ?? header;
            band.least = band.header + band.cxMinChild + AFTER_CHILD;
            const child = band.child !== 0 ? childHeight(band)
                + ((band.style & RBBS_CHILDEDGE) !== 0 ? 2 * CHILD_EDGE : 0) : 0;
            thickness.set(band, Math.max(LEAST_HEIGHT, child,
                title ? extents.line + 4 : 0, image ? image.cy + 4 : 0));
        });
        return thickness;
    };

    /** @param {Band} band  The length a band asks for. */
    const asked = band=>Math.max(band.cx, band.least);

    /**
     * One row's lengths: each band as long as it asks, then made to fill
     * the row.
     *
     * Not measured against Windows: the real control sometimes leaves the
     * room on a band before the last that held it in an earlier layout
     * (Wine's rebar test, test_layout, after the fourth band and after the
     * last deletion), a rule its tests do not pin down.
     *
     * @param {Band[]} row @param {number} room  the row's length, borders taken out
     */
    const fillRow = (row, room)=>{
        const lengths = row.map(band=>asked(band));
        let over = lengths.reduce((sum, length)=>sum + length, 0) - room;
        for (let at = row.length - 1; at >= 0 && over > 0; at--)
        {
            const take = Math.min(over, Math.max(0, lengths[at] - row[at].least));
            lengths[at] -= take;
            over -= take;
        }
        if (over < 0)
        {
            lengths[row.length - 1] -= over;
        }
        row.forEach((band, at)=>{
            band.length = lengths[at];
        });
    };

    /**
     * The client area's length along the bar, and across.
     *
     * @param {any} record
     */
    const clientExtent = record=>{
        const size = host.clientSize(record);
        return (record.style & CCS_VERT) !== 0
            ? { along: size.height, across: size.width }
            : { along: size.width, across: size.height };
    };

    /**
     * How long the bar will be: its own length when it does not follow its
     * parent, else the parent's along the same edge.
     *
     * @param {any} record
     */
    const barLength = record=>{
        const parent = record.parent ? host.live(record.parent) : null;
        if ((record.style & (CCS_NORESIZE | CCS_NOPARENTALIGN)) !== 0 || !parent)
        {
            return clientExtent(record).along;
        }
        const room = host.clientSize(parent);
        return (record.style & CCS_VERT) !== 0 ? room.height : room.width;
    };

    /**
     * Breaks the shown bands into rows and lays each out; the bar's thickness,
     * which stays as it was while no band is shown.
     *
     * @param {any} record
     */
    const arrange = record=>{
        const held = state(record);
        const length = barLength(record);
        const between = (record.style & RBS_BANDBORDERS) !== 0 ? BAND_BORDER : 0;
        const thickness = measureBands(record);
        /** @type {Band[][]} */
        const rows = [];
        let used = 0;
        for (const band of held.bands.filter(visible))
        {
            const row = rows.at(-1);
            if (!row || (band.style & RBBS_BREAK) !== 0 || used + between + band.least > length)
            {
                rows.push([band]);
                used = band.least;
            }
            else
            {
                row.push(band);
                used += between + band.least;
            }
        }
        const tallest = Math.max(0, ...thickness.values());
        let top = 0;
        held.rows = rows.map((row, index)=>{
            fillRow(row, length - between * (row.length - 1));
            const height = (record.style & RBS_VARHEIGHT) !== 0
                ? Math.max(...row.map(band=>/** @type {number} */ (thickness.get(band))))
                : tallest;
            let left = 0;
            for (const band of row)
            {
                const end = left + /** @type {number} */ (band.length);
                band.rect = { left, top, right: end, bottom: top + height };
                band.row = index;
                left = end + between;
            }
            const placed = { top, height };
            top += height + between;
            return placed;
        });
        held.laidLength = length;
        held.vertical = (record.style & CCS_VERT) !== 0;
        if (rows.length > 0 || held.thickness === null)
        {
            held.thickness = rows.length > 0 ? top - between : 0;
        }
        return held.thickness;
    };

    /**
     * Where the bar goes at the thickness it was laid out at, or null where
     * it stays: a bar of CCS_NORESIZE, or one with no parent.
     *
     * @param {any} record
     */
    const placement = record=>{
        const held = state(record);
        const thickness = /** @type {number} */ (held.thickness);
        const vertical = (record.style & CCS_VERT) !== 0;
        const parent = record.parent ? host.live(record.parent) : null;
        if ((record.style & CCS_NORESIZE) !== 0 || !parent)
        {
            return null;
        }
        const client = host.clientSize(record);
        const frame = { width: record.width - client.width, height: record.height - client.height };
        if ((record.style & CCS_NOPARENTALIGN) !== 0)
        {
            return { x: record.x, y: record.y,
                width: vertical ? thickness + frame.width : record.width,
                height: vertical ? record.height : thickness + frame.height };
        }
        const room = host.clientSize(parent);
        const align = record.style & 0x3;
        const divider = (record.style & CCS_NODIVIDER) === 0 && (record.style & WS_BORDER) === 0
            ? 2 : 0;
        if (vertical)
        {
            const width = thickness + frame.width;
            const x = align === CCS_NOMOVEY ? record.x
                : align === CCS_BOTTOM ? room.width - width : divider;
            return { x, y: -frame.height / 2, width, height: room.height + frame.height };
        }
        const height = thickness + frame.height;
        const y = align === CCS_NOMOVEY ? record.y
            : align === CCS_BOTTOM ? room.height - height : divider;
        return { x: -frame.width / 2, y, width: room.width + frame.width, height };
    };

    /**
     * What puts each band's child where its band is - past the header, as
     * long as the band less the space after the child, its least height
     * within an edge - and shows it, or hides the child of a hidden band:
     * one step per child that is not there yet.
     *
     * @param {any} record
     * @returns {(() => unknown)[]}
     */
    const childSteps = record=>{
        const held = state(record);
        /** @type {(() => unknown)[]} */
        const steps = [];
        // The children of deleted bands, and those a band was given in
        // their place, are hidden.
        const dropped = [...held.dropped, ...held.bands.flatMap(band=>band.dropped)]
            .filter(hwnd=>hwnd !== 0 && !held.bands.some(band=>band.child === hwnd));
        held.dropped = [];
        held.bands.forEach(band=>{
            band.dropped = [];
        });
        for (const hwnd of dropped)
        {
            if (((host.live(hwnd)?.style ?? 0) & WS_VISIBLE) !== 0)
            {
                steps.push(()=>host.show?.(hwnd, SW_HIDE));
            }
        }
        for (const band of held.bands)
        {
            const child = band.child !== 0 ? host.live(band.child) : null;
            if (!child)
            {
                continue;
            }
            const shown = (child.style & WS_VISIBLE) !== 0;
            if (!visible(band))
            {
                if (shown)
                {
                    steps.push(()=>host.show?.(band.child, SW_HIDE));
                }
                continue;
            }
            const edge = (band.style & RBBS_CHILDEDGE) !== 0 ? CHILD_EDGE : 0;
            const row = band.rect.bottom - band.rect.top;
            const height = (band.style & RBBS_VARIABLEHEIGHT) !== 0
                ? childHeight(band) : Math.min(band.cyMinChild, row - 2 * edge);
            const along = band.rect.left + band.header;
            const across = band.rect.top + Math.max(edge, Math.floor((row - height) / 2));
            const length = Math.max(0, band.rect.right - along - AFTER_CHILD);
            const [x, y, width, tall] = held.vertical ? [across, along, height, length]
                : [along, across, length, height];
            if (host.move && (child.x !== x || child.y !== y || child.width !== width
                || child.height !== tall))
            {
                steps.push(()=>host.move?.(band.child, x, y, width, tall));
            }
            if (!shown)
            {
                steps.push(()=>host.show?.(band.child, SW_SHOW));
            }
        }
        return steps;
    };

    /**
     * Takes the steps one after another: a move or a show that calls the
     * program back is answered before the next begins.
     *
     * @param {any} record
     * @returns {unknown}
     */
    const placeChildren = record=>childSteps(record)
        .reduce((done, step)=>after(done, ()=>step()), /** @type {unknown} */ (0));

    /**
     * The NMHDR every notification starts with, followed by `rest` bytes the
     * caller fills, in guest memory for as long as the parent answers.
     *
     * @param {any} record @param {number} code @param {unknown} thread
     * @param {number} [rest] @param {(address: number) => void} [fill]
     * @returns {number | Promise<number>}
     */
    const notify = (record, code, thread, rest = 0, fill)=>{
        const target = ownerOf(record);
        const size = 3 * pointer + rest;
        const address = target !== 0 && host.allocate ? host.allocate(size) : 0;
        if (address === 0)
        {
            return 0;
        }
        host.writeMemory(address, new Uint8Array(size));
        setPointer(address, record.hwnd);
        setPointer(address + pointer, record.id);
        setU32(address + 2 * pointer, code);
        fill?.(address + 3 * pointer);
        return after(host.send(target, WM_NOTIFY, record.id, address, thread), answer=>{
            host.release?.(address);
            return answer;
        });
    };

    /**
     * Lays the bands out again and puts the bar and the children where the
     * layout says, telling the parent when the bar's thickness changed.
     *
     * @param {any} record @param {unknown} [thread]
     * @returns {unknown}
     */
    const layout = (record, thread)=>{
        const held = state(record);
        const before = held.thickness;
        arrange(record);
        const place = placement(record);
        const moved = !place || !host.move || place.x === record.x && place.y === record.y
            && place.width === record.width && place.height === record.height ? 0
            : (held.placing = true,
            host.move(record.hwnd, place.x, place.y, place.width, place.height));
        const tell = ()=>{
            held.placing = false;
            host.invalidate(record);
            return before !== null && before !== held.thickness
                ? notify(record, RBN_HEIGHTCHANGE, thread) : 0;
        };
        return after(after(moved, ()=>placeChildren(record)), tell);
    };

    /** A band as RB_INSERTBAND makes it before its fields are read. @returns {Band} */
    const newBand = ()=>({
        style: 0, fore: 0, back: host.sysColor(COLOR_3DFACE), text: '', image: -1, child: 0,
        cxMinChild: 0, cyMinChild: 0, cx: 0, bitmap: 0, id: 0, cyChild: 0,
        cyMaxChild: NO_MAXIMUM, cyIntegral: 0, cxIdeal: 0, param: new Uint8Array(pointer),
        fixedHeader: null, header: 0, least: 0, length: null, row: 0, dropped: [],
        rect: { left: 0, top: 0, right: 0, bottom: 0 },
    });

    /**
     * Reads the fields a REBARBANDINFO's mask names onto a band. False for a
     * structure smaller than the oldest version.
     *
     * @param {Band} band @param {number} address @param {boolean} wide
     */
    const readInfo = (band, address, wide)=>{
        const size = u32(address);
        if (address === 0 || size < INFO.v3)
        {
            return false;
        }
        const mask = u32(address + INFO.fMask);
        const v6 = size >= INFO.v6;
        if ((mask & RBBIM_STYLE) !== 0)
        {
            band.style = u32(address + INFO.fStyle) & ~RBBS_FIXEDHEADER;
            band.fixedHeader = null;
        }
        if ((mask & RBBIM_COLORS) !== 0)
        {
            band.fore = u32(address + INFO.clrFore);
            band.back = u32(address + INFO.clrBack);
        }
        if ((mask & RBBIM_TEXT) !== 0)
        {
            const text = u32(address + INFO.lpText);
            band.text = text === 0 ? '' : readText(host, text, wide);
        }
        if ((mask & RBBIM_IMAGE) !== 0)
        {
            band.image = u32(address + INFO.iImage) | 0;
        }
        if ((mask & RBBIM_CHILD) !== 0)
        {
            const child = u32(address + INFO.hwndChild);
            if (band.child !== 0 && band.child !== child)
            {
                band.dropped.push(band.child);
            }
            band.child = child;
        }
        if ((mask & RBBIM_CHILDSIZE) !== 0)
        {
            band.cxMinChild = u32(address + INFO.cxMinChild) | 0;
            band.cyMinChild = u32(address + INFO.cyMinChild) | 0;
            // Only a band of variable height keeps the rest: any other is
            // as tall as its least (Wine's rebar test, test_bandinfo).
            const variable = (band.style & RBBS_VARIABLEHEIGHT) !== 0;
            band.cyChild = variable ? u32(address + INFO.cyChild) | 0 : band.cyMinChild;
            band.cyMaxChild = variable ? u32(address + INFO.cyMaxChild) | 0 : NO_MAXIMUM;
            band.cyIntegral = variable ? u32(address + INFO.cyIntegral) | 0 : 0;
        }
        if ((mask & RBBIM_SIZE) !== 0)
        {
            band.cx = u32(address + INFO.cx) | 0;
        }
        if ((mask & RBBIM_BACKGROUND) !== 0)
        {
            band.bitmap = u32(address + INFO.hbmBack);
        }
        if ((mask & RBBIM_ID) !== 0)
        {
            band.id = u32(address + INFO.wID);
        }
        if (v6 && (mask & RBBIM_IDEALSIZE) !== 0)
        {
            band.cxIdeal = u32(address + INFO.cxIdeal) | 0;
        }
        if (v6 && (mask & RBBIM_LPARAM) !== 0)
        {
            band.param = host.readMemory(address + INFO.lParam, pointer).slice();
        }
        if (v6 && (mask & RBBIM_HEADERSIZE) !== 0)
        {
            band.fixedHeader = u32(address + INFO.cxHeader) | 0;
        }
        return true;
    };

    /**
     * Fills the fields a REBARBANDINFO's mask asks for. A band not of
     * variable height leaves cyChild, cyMaxChild and cyIntegral as they were
     * in the caller's structure, as the real control does.
     *
     * @param {any} record @param {Band} band @param {number} address @param {boolean} wide
     */
    const writeInfo = (record, band, address, wide)=>{
        const size = u32(address);
        if (size < INFO.v3)
        {
            return false;
        }
        measureBands(record);
        const mask = u32(address + INFO.fMask);
        const v6 = size >= INFO.v6;
        if ((mask & RBBIM_STYLE) !== 0)
        {
            setU32(address + INFO.fStyle, band.style
                | (band.fixedHeader !== null ? RBBS_FIXEDHEADER : 0));
        }
        if ((mask & RBBIM_COLORS) !== 0)
        {
            setU32(address + INFO.clrFore, band.fore);
            setU32(address + INFO.clrBack, band.back);
        }
        if ((mask & RBBIM_TEXT) !== 0)
        {
            writeText(host, u32(address + INFO.lpText), band.text, wide,
                u32(address + INFO.cch) | 0);
        }
        if ((mask & RBBIM_IMAGE) !== 0)
        {
            setU32(address + INFO.iImage, band.image);
        }
        if ((mask & RBBIM_CHILD) !== 0)
        {
            setPointer(address + INFO.hwndChild, band.child);
        }
        if ((mask & RBBIM_CHILDSIZE) !== 0)
        {
            setU32(address + INFO.cxMinChild, band.cxMinChild);
            setU32(address + INFO.cyMinChild, band.cyMinChild);
            if ((band.style & RBBS_VARIABLEHEIGHT) !== 0)
            {
                setU32(address + INFO.cyChild, childHeight(band));
                setU32(address + INFO.cyMaxChild, band.cyMaxChild);
                setU32(address + INFO.cyIntegral, band.cyIntegral);
            }
        }
        if ((mask & RBBIM_SIZE) !== 0)
        {
            setU32(address + INFO.cx, band.cx);
        }
        if ((mask & RBBIM_BACKGROUND) !== 0)
        {
            setPointer(address + INFO.hbmBack, band.bitmap);
        }
        if ((mask & RBBIM_ID) !== 0)
        {
            setU32(address + INFO.wID, band.id);
        }
        if (v6 && (mask & RBBIM_IDEALSIZE) !== 0)
        {
            setU32(address + INFO.cxIdeal, band.cxIdeal);
        }
        if (v6 && (mask & RBBIM_LPARAM) !== 0)
        {
            host.writeMemory(address + INFO.lParam, band.param);
        }
        if (v6 && (mask & RBBIM_HEADERSIZE) !== 0)
        {
            setU32(address + INFO.cxHeader, band.header);
        }
        return true;
    };

    /**
     * The shown bands of a band's row, in order.
     *
     * @param {any} record @param {Band} band
     */
    const rowOf = (record, band)=>state(record).bands
        .filter(other=>visible(other) && other.row === band.row);

    /**
     * RB_MAXIMIZEBAND: the band grows - to its ideal length when asked and it
     * is shorter, else as far as it can - taking from the bands after it,
     * then from those before, each down to its least. Every band whose
     * length changed asks for that length from then on.
     *
     * @param {any} record @param {Band} band @param {boolean} ideal
     */
    const maximize = (record, band, ideal)=>{
        const row = rowOf(record, band);
        const at = row.indexOf(band);
        const length = /** @type {number} */ (band.length ?? band.cx);
        const idealLength = band.cxIdeal + band.header + AFTER_CHILD;
        let wanted = ideal && length < idealLength ? idealLength - length : Infinity;
        const donors = [...row.slice(at + 1), ...row.slice(0, at).reverse()];
        for (const donor of donors)
        {
            const has = /** @type {number} */ (donor.length ?? donor.cx);
            const take = Math.min(wanted, Math.max(0, has - donor.least));
            if (take > 0)
            {
                donor.length = has - take;
                donor.cx = donor.length;
                band.length = /** @type {number} */ (band.length ?? band.cx) + take;
                band.cx = band.length;
                wanted -= take;
            }
        }
    };

    /**
     * RB_MINIMIZEBAND: the band goes down to its least, the length it gives
     * up going to the band before it (or after it, for the first in a row).
     *
     * @param {any} record @param {Band} band
     */
    const minimize = (record, band)=>{
        const row = rowOf(record, band);
        const at = row.indexOf(band);
        const neighbour = row[at > 0 ? at - 1 : at + 1];
        const freed = /** @type {number} */ (band.length ?? band.cx) - band.least;
        if (!neighbour || freed <= 0)
        {
            return;
        }
        band.length = band.least;
        band.cx = band.length;
        neighbour.length = /** @type {number} */ (neighbour.length ?? neighbour.cx) + freed;
        neighbour.cx = neighbour.length;
    };

    /**
     * The chevron of a band that shows one: RBBS_USECHEVRON and less room
     * for the child than its ideal width. An empty rectangle otherwise.
     *
     * @param {Band} band @returns {Rect}
     */
    const chevronOf = band=>{
        const room = band.rect.right - band.rect.left - band.header - AFTER_CHILD;
        if ((band.style & RBBS_USECHEVRON) === 0 || !visible(band) || room >= band.cxIdeal)
        {
            return { left: 0, top: 0, right: 0, bottom: 0 };
        }
        return { left: band.rect.right - CHEVRON, top: band.rect.top, right: band.rect.right,
            bottom: band.rect.bottom };
    };

    /** A rectangle along the bar as the client area has it. @param {any} record @param {Rect} rect */
    const onClient = (record, rect)=>(state(record).vertical
        ? { left: rect.top, top: rect.left, right: rect.bottom, bottom: rect.right } : rect);

    /** @param {any} record @param {number} hdc */
    const paintBar = (record, hdc)=>{
        const held = state(record);
        const draw = /** @type {any} */ (host.draw);
        draw.fill(hdc, tk.clientRect(record), held.bkColor === CLR_NONE
            ? tk.color(COLOR_3DFACE) : held.bkColor);
        const bordered = (record.style & RBS_BANDBORDERS) !== 0;
        const shown = held.bands.filter(visible);
        const grippers = shown.length > 1;
        for (const band of shown)
        {
            const rect = band.rect;
            if (band.back !== host.sysColor(COLOR_3DFACE))
            {
                draw.fill(hdc, onClient(record, rect), band.back);
            }
            const gripper = (band.style & RBBS_GRIPPERALWAYS) !== 0
                || grippers && (band.style & RBBS_NOGRIPPER) === 0;
            if (gripper)
            {
                tk.edge(hdc, onClient(record, { left: rect.left + 2, top: rect.top + 2,
                    right: rect.left + GRIPPER, bottom: rect.bottom - 2 }),
                tk.color(COLOR_3DHILIGHT), tk.color(COLOR_3DSHADOW));
            }
            if (titled(band) && !held.vertical)
            {
                const image = imageSize(record, band);
                const left = rect.left + (gripper ? GRIPPER : 0) + AFTER_GRIPPER
                    + (image ? image.cx + AFTER_IMAGE : 0);
                tk.drawText(hdc, band.text, { left, top: rect.top, right: rect.left + band.header,
                    bottom: rect.bottom }, DT_LEFT | DT_VCENTER | DT_SINGLELINE,
                held.textColor === CLR_NONE ? band.fore || tk.color(COLOR_BTNTEXT)
                    : held.textColor);
            }
            const image = imageSize(record, band);
            if (image && images)
            {
                const left = rect.left + (gripper ? GRIPPER : 0) + AFTER_GRIPPER;
                const top = rect.top + Math.floor((rect.bottom - rect.top - image.cy) / 2);
                const at = onClient(record, { left, top, right: left, bottom: top });
                images.draw(held.list, band.image, hdc, at.left, at.top);
            }
            if (bordered)
            {
                tk.edge(hdc, onClient(record, { left: rect.right, top: rect.top,
                    right: rect.right + BAND_BORDER, bottom: rect.bottom }),
                tk.color(COLOR_3DSHADOW), tk.color(COLOR_3DHILIGHT));
            }
        }
        if (bordered)
        {
            const across = clientExtent(record).along;
            for (const row of held.rows.slice(0, -1))
            {
                const top = row.top + row.height;
                tk.edge(hdc, onClient(record, { left: 0, top, right: across,
                    bottom: top + BAND_BORDER }),
                tk.color(COLOR_3DSHADOW), tk.color(COLOR_3DHILIGHT));
            }
        }
    };

    /**
     * RB_HITTEST: the band under a point of the client area and what of it.
     *
     * @param {any} record @param {number} address  the RBHITTESTINFO
     */
    const hitTest = (record, address)=>{
        const held = state(record);
        const bytes = host.readMemory(address, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        const x = view.getInt32(0, true);
        const y = view.getInt32(4, true);
        const [along, across] = held.vertical ? [y, x] : [x, y];
        const index = held.bands.findIndex(band=>visible(band) && along >= band.rect.left
            && along < band.rect.right && across >= band.rect.top && across < band.rect.bottom);
        const band = held.bands[index];
        let flags = RBHT_NOWHERE;
        if (band)
        {
            const chevron = chevronOf(band);
            flags = chevron.right > chevron.left && along >= chevron.left ? RBHT_CHEVRON
                : along < band.rect.left + Math.min(band.header, GRIPPER + AFTER_GRIPPER)
                    && band.header >= GRIPPER ? RBHT_GRABBER
                    : along < band.rect.left + band.header ? RBHT_CAPTION : RBHT_CLIENT;
        }
        setU32(address + 8, flags);
        setU32(address + 12, index);
        return index;
    };

    /** @param {any} record @param {number} index */
    const bandAt = (record, index)=>state(record).bands[index | 0] ?? null;

    /**
     * @param {any} record @param {ControlMessage} message @param {unknown} [thread]
     */
    return (record, message, thread)=>{
        const held = state(record);
        const id = message.message >>> 0;
        const wParam = message.wParam >>> 0;
        const lParam = message.lParam >>> 0;
        switch (id){
            case WM_CREATE:
                return after(layout(record, thread), ()=>tk.common(record, message, thread));
            case WM_SIZE:
            case WM_STYLECHANGED: {
                if (held.placing)
                {
                    return 0;
                }
                const turned = held.vertical !== ((record.style & CCS_VERT) !== 0);
                if (!turned && barLength(record) === held.laidLength)
                {
                    const place = placement(record);
                    return !place || !host.move || place.x === record.x && place.y === record.y
                        && place.width === record.width && place.height === record.height ? 0
                        : after(layout(record, thread), ()=>0);
                }
                return after(layout(record, thread), ()=>0);
            }
            case WM_NCCALCSIZE:
                // WS_BORDER gives a rebar an edge two pixels wide.
                if ((record.style & (WS_BORDER | WS_DLGFRAME)) === WS_BORDER && lParam !== 0)
                {
                    const bytes = host.readMemory(lParam, 16);
                    const rect = new Int32Array(bytes.slice().buffer);
                    setRect(lParam, { left: rect[0] + BORDER_EDGE, top: rect[1] + BORDER_EDGE,
                        right: rect[2] - BORDER_EDGE, bottom: rect[3] - BORDER_EDGE });
                    return 0;
                }
                return tk.common(record, message, thread);
            case WM_PAINT:
                return tk.painting(record, (/** @type {number} */ hdc)=>{
                    paintBar(record, hdc);
                    return 0;
                });
            case WM_SETFONT:
                record.font = wParam;
                return after(layout(record, thread), ()=>0);
            // What a band's child tells its parent reaches the bar's.
            case WM_NOTIFY:
            case WM_COMMAND:
            case WM_DRAWITEM:
            case WM_MEASUREITEM: {
                const to = ownerOf(record);
                return to !== 0 ? host.send(to, id, wParam, lParam, thread) : 0;
            }
            case RB_INSERTBANDA:
            case RB_INSERTBANDW: {
                const band = newBand();
                if (!readInfo(band, lParam, id === RB_INSERTBANDW))
                {
                    return 0;
                }
                const at = (wParam | 0) < 0 || wParam > held.bands.length
                    ? held.bands.length : wParam;
                held.bands.splice(at, 0, band);
                return after(layout(record, thread), ()=>1);
            }
            case RB_DELETEBAND: {
                const band = bandAt(record, wParam);
                if (!band)
                {
                    return 0;
                }
                held.bands.splice(wParam, 1);
                held.dropped.push(band.child, ...band.dropped);
                return after(layout(record, thread), ()=>1);
            }
            case RB_SETBANDINFOA:
            case RB_SETBANDINFOW: {
                const band = bandAt(record, wParam);
                if (!band || !readInfo(band, lParam, id === RB_SETBANDINFOW))
                {
                    return 0;
                }
                return after(layout(record, thread), ()=>1);
            }
            case RB_GETBANDINFO_OLD:
            case RB_GETBANDINFOA:
            case RB_GETBANDINFOW: {
                const band = bandAt(record, wParam);
                return band && lParam !== 0
                    && writeInfo(record, band, lParam, id === RB_GETBANDINFOW) ? 1 : 0;
            }
            case RB_GETBARINFO:
            case RB_SETBARINFO: {
                if (lParam === 0 || u32(lParam) < 8 + pointer)
                {
                    return 0;
                }
                if ((u32(lParam + 4) & RBIM_IMAGELIST) !== 0)
                {
                    if (id === RB_GETBARINFO)
                    {
                        setPointer(lParam + 8, held.list);
                    }
                    else
                    {
                        held.list = u32(lParam + 8);
                        return after(layout(record, thread), ()=>1);
                    }
                }
                return 1;
            }
            case RB_SETPARENT: {
                const previous = ownerOf(record);
                held.owner = wParam;
                return previous;
            }
            case RB_HITTEST:
                return lParam === 0 ? -1 : hitTest(record, lParam);
            case RB_GETRECT: {
                const band = bandAt(record, wParam);
                if (!band || lParam === 0)
                {
                    return 0;
                }
                setRect(lParam, band.rect);
                return 1;
            }
            case RB_GETBANDCOUNT:
                return held.bands.length;
            case RB_GETROWCOUNT:
                return held.rows.length;
            case RB_GETROWHEIGHT:
                return held.rows[wParam]?.height ?? 0;
            case RB_GETBARHEIGHT:
                return held.thickness ?? 0;
            case RB_IDTOINDEX:
                return held.bands.findIndex(band=>band.id === wParam);
            case RB_GETTOOLTIPS:
                return held.tooltips;
            case RB_SETTOOLTIPS:
                held.tooltips = wParam;
                return 0;
            case RB_SETBKCOLOR:
            case RB_SETTEXTCOLOR: {
                const key = id === RB_SETBKCOLOR ? 'bkColor' : 'textColor';
                const previous = held[key];
                held[key] = lParam;
                host.invalidate(record);
                return previous;
            }
            case RB_GETBKCOLOR:
                return held.bkColor;
            case RB_GETTEXTCOLOR:
                return held.textColor;
            case RB_GETCOLORSCHEME:
                // COLORSCHEME: its size, then the highlight and the shadow,
                // which the bar leaves to the system.
                if (lParam === 0)
                {
                    return 0;
                }
                setU32(lParam + 4, CLR_DEFAULT);
                setU32(lParam + 8, CLR_DEFAULT);
                return 1;
            case RB_SETCOLORSCHEME:
                return 0;
            case RB_MINIMIZEBAND:
            case RB_MAXIMIZEBAND: {
                const band = bandAt(record, wParam);
                if (!band || !visible(band))
                {
                    return 0;
                }
                measureBands(record);
                if (id === RB_MINIMIZEBAND)
                {
                    minimize(record, band);
                }
                else
                {
                    maximize(record, band, lParam !== 0);
                }
                return after(layout(record, thread), ()=>0);
            }
            case RB_GETBANDBORDERS: {
                const band = bandAt(record, wParam);
                if (!band || lParam === 0)
                {
                    return 0;
                }
                measureBands(record);
                const edge = (band.style & RBBS_CHILDEDGE) !== 0 ? CHILD_EDGE : 0;
                setRect(lParam, (record.style & RBS_BANDBORDERS) !== 0
                    ? { left: band.header, top: edge, right: AFTER_CHILD, bottom: edge }
                    : { left: band.header, top: 0, right: 0, bottom: 0 });
                return 1;
            }
            case RB_SHOWBAND: {
                const band = bandAt(record, wParam);
                if (!band)
                {
                    return 0;
                }
                band.style = lParam !== 0 ? band.style & ~RBBS_HIDDEN : band.style | RBBS_HIDDEN;
                return after(layout(record, thread), ()=>1);
            }
            case RB_MOVEBAND: {
                const count = held.bands.length;
                const to = lParam | 0;
                if ((wParam | 0) < 0 || wParam >= count || to < 0 || to >= count)
                {
                    return 0;
                }
                const [band] = held.bands.splice(wParam, 1);
                held.bands.splice(to, 0, band);
                return after(layout(record, thread), ()=>1);
            }
            case RB_SETBANDWIDTH: {
                const band = bandAt(record, wParam);
                if (!band)
                {
                    return 0;
                }
                band.cx = lParam | 0;
                return after(layout(record, thread), ()=>1);
            }
            case RB_PUSHCHEVRON: {
                const band = bandAt(record, wParam);
                if (!band)
                {
                    return 0;
                }
                // NMREBARCHEVRON after its NMHDR: the band, its id and
                // lParam, the chevron's rectangle and the caller's lParam.
                return after(notify(record, RBN_CHEVRONPUSHED, thread, 4 * pointer + 16,
                    address=>{
                        setU32(address, wParam);
                        setU32(address + 4, band.id);
                        host.writeMemory(address + 8, band.param);
                        const rect = address + 8 + pointer;
                        setRect(rect, onClient(record, chevronOf(band)));
                        setPointer(rect + 16, lParam);
                    }), ()=>0);
            }
            case RB_SETPALETTE: {
                const previous = held.palette;
                held.palette = lParam;
                return previous;
            }
            case RB_GETPALETTE:
                return held.palette;
            case RB_SETEXTENDEDSTYLE: {
                const previous = held.extended;
                held.extended = wParam === 0 ? lParam : held.extended & ~wParam | lParam & wParam;
                return previous;
            }
            case RB_GETEXTENDEDSTYLE:
                return held.extended;
            case RB_SETUNICODEFORMAT: {
                const previous = held.unicode ? 1 : 0;
                held.unicode = wParam !== 0;
                return previous;
            }
            case RB_GETUNICODEFORMAT:
                return held.unicode ? 1 : 0;
            case CCM_SETVERSION:
            case CCM_GETVERSION:
                return answerVersion(record, held, id, wParam);
            default:
                return tk.common(record, message, thread);
        }
    };
}
