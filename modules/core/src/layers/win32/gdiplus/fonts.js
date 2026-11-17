/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s fonts: families by name or generic, fonts of a family at a size and
 * style, from a LOGFONT or a DC's font, and their measurements - what
 * System.Drawing reads when WinForms starts (Control.DefaultFont is
 * SystemFonts.DefaultFont, DEFAULT_GUI_FONT through Font.FromHfont, measured
 * in points by Font.SizeInPoints) and when it lays out text.
 *
 * A family is one of gdi32's faces (`faces.js`), its design metrics gdi32's
 * own for the face (`designCell`), so GDI and GDI+ measure a face alike. GDI+
 * takes outline faces only: a bitmap face named in a LOGFONT is
 * NotTrueTypeFont, and by name it is a family not found, as GDI+ answers.
 */

import { FF_MODERN, FF_ROMAN, designCell, faceNamed } from '../gdi32/faces.js';

/** GpStatus (gdiplustypes.h). */
const Ok = 0;
const InvalidParameter = 2;
const OutOfMemory = 3;
const FontFamilyNotFound = 14;
const NotTrueTypeFont = 16;

/** GpUnit. A font may be in any but Display, which names no size of its own. */
const UnitWorld = 0;
const UnitDisplay = 1;
const UnitPoint = 3;
const UnitInch = 4;
const UnitDocument = 5;
const UnitMillimeter = 6;

/** FontStyle. */
const FontStyleBold = 1;
const FontStyleItalic = 2;
const FontStyleUnderline = 4;
const FontStyleStrikeout = 8;

/** The display's resolution, as gdi32 answers LOGPIXELSX and LOGPIXELSY. */
const DPI = 96;

/** LOGFONTW: the fields to lfPitchAndFamily, then lfFaceName of LF_FACESIZE characters. */
const LF_FACE = 28;
const LF_FACESIZE = 32;
/** FW_BOLD's half-way down, where GDI starts drawing a face bold. */
const BOLD_WEIGHT = 600;
const DEFAULT_CHARSET = 1;

/** The faces GDI+'s generic families are (GdipGetGenericFontFamily*). */
const SANS_SERIF = 'Microsoft Sans Serif';
const SERIF = 'Times New Roman';
const MONOSPACE = 'Courier New';

/**
 * Pixels of `size` in `unit` at `dpi`.
 *
 * @param {number} size @param {number} unit @param {number} dpi
 */
const pixelsOf = (size, unit, dpi)=>{
    switch (unit)
    {
        case UnitPoint: return size * dpi / 72;
        case UnitInch: return size * dpi;
        case UnitDocument: return size * dpi / 300;
        case UnitMillimeter: return size * dpi / 25.4;
        default: return size;
    }
};

/**
 * The outline face a name is, substitutes followed; 'bitmap' for a bitmap face,
 * null for none.
 *
 * @param {string} name
 * @returns {string | 'bitmap' | null}
 */
const outlineFace = name=>{
    const named = faceNamed(name);
    const face = named?.substitute ? faceNamed(named.substitute) : named;
    if (!face)
    {
        return null;
    }
    return designCell(face.name) ? face.name : 'bitmap';
};

/**
 * @param {Object} options
 * @param {import('./functions.js').GdiplusHost} options.host
 * @param {() => number} options.handle  A new GDI+ object's handle.
 * @param {(address: number, value: number) => void} options.putPointer
 * @param {(handle: number) => boolean} options.isGraphics
 */
export function createFontFunctions({ host, handle, putPointer, isGraphics }){
    /** @type {Map<number, string>} each family: its face */
    const families = new Map();
    /** @type {Map<number, { face: string, size: number, style: number, unit: number }>} */
    const fonts = new Map();

    /** @param {number} address @param {number} value */
    const putFloat = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Float32Array.of(value).buffer));
    /** @param {number} address @param {number} value */
    const putU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} address @param {number} value */
    const putU16 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint16Array.of(value).buffer));
    /** A REAL argument, as its bits arrive. @param {number} bits */
    const real = bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0];

    /** @param {string} face @param {number} out */
    const newFamily = (face, out)=>{
        const made = handle();
        families.set(made, face);
        putPointer(out, made);
        return Ok;
    };
    /** @param {{ face: string, size: number, style: number, unit: number }} font @param {number} out */
    const newFont = (font, out)=>{
        const made = handle();
        fonts.set(made, { ...font });
        putPointer(out, made);
        return Ok;
    };

    /**
     * A font from a LOGFONT's fields: an outline face, its unknown names the
     * face of their family's generic one as GDI's mapper picks; a size in
     * World units of the character height asked, a cell height becoming the
     * em it holds.
     *
     * @param {DataView} lf @param {string} name @param {number} out
     */
    const fromLogfont = (lf, name, out)=>{
        const family = lf.getUint8(27) & 0xf0;
        const found = outlineFace(name);
        if (found === 'bitmap')
        {
            return NotTrueTypeFont;
        }
        const face = found ?? (family === FF_ROMAN ? SERIF
            : family === FF_MODERN ? MONOSPACE : SANS_SERIF);
        const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (designCell(face));
        const height = lf.getInt32(0, true);
        const size = height < 0 ? -height
            : height > 0 ? height * cell.unitsPerEm / (cell.ascent + cell.descent) : 13;
        const style = (lf.getInt32(16, true) >= BOLD_WEIGHT ? FontStyleBold : 0)
            | (lf.getUint8(20) ? FontStyleItalic : 0)
            | (lf.getUint8(21) ? FontStyleUnderline : 0)
            | (lf.getUint8(22) ? FontStyleStrikeout : 0);
        return newFont({ face, size, style, unit: UnitWorld }, out);
    };

    /** @param {number} address @param {boolean} wide */
    const readLogfont = (address, wide)=>{
        const bytes = host.readMemory(address >>> 0, LF_FACE + LF_FACESIZE * (wide ? 2 : 1))
            .slice();
        const names = bytes.subarray(LF_FACE);
        const text = wide ? String.fromCharCode(...new Uint16Array(names.buffer, names.byteOffset,
            LF_FACESIZE)) : String.fromCharCode(...names);
        return { view: new DataView(bytes.buffer), name: text.split('\0')[0] };
    };

    /**
     * A LOGFONT of a font, at the display's resolution: a negative height for
     * the em in pixels, its weight and flags from the style, its face's name.
     *
     * @param {number} font @param {number} out @param {boolean} wide
     */
    const toLogfont = (font, out, wide)=>{
        const held = fonts.get(font >>> 0);
        if (!held || (out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        const bytes = new Uint8Array(LF_FACE + LF_FACESIZE * (wide ? 2 : 1));
        const view = new DataView(bytes.buffer);
        view.setInt32(0, -Math.round(pixelsOf(held.size, held.unit, DPI)), true);
        view.setInt32(16, held.style & FontStyleBold ? 700 : 400, true);
        bytes[20] = held.style & FontStyleItalic ? 1 : 0;
        bytes[21] = held.style & FontStyleUnderline ? 1 : 0;
        bytes[22] = held.style & FontStyleStrikeout ? 1 : 0;
        bytes[23] = DEFAULT_CHARSET;
        const name = held.face.slice(0, LF_FACESIZE - 1);
        for (let i = 0; i < name.length; i++)
        {
            if (wide)
            {
                view.setUint16(LF_FACE + i * 2, name.charCodeAt(i), true);
            }
            else
            {
                bytes[LF_FACE + i] = name.charCodeAt(i) & 0xff;
            }
        }
        host.writeMemory(out >>> 0, bytes);
        return Ok;
    };

    /**
     * One of a family's design metrics, in font units.
     *
     * @param {'unitsPerEm' | 'ascent' | 'descent' | 'spacing'} which
     */
    const familyMetric = which=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [family, , out])=>{
            const face = families.get(family >>> 0);
            if (face === undefined || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
                designCell(face));
            putU16(out, which === 'spacing' ? cell.ascent + cell.descent : cell[which]);
            return Ok;
        },
    });

    /**
     * A font's line spacing in pixels at `dpi`: its em in pixels over the em
     * its family is designed in, times the cell.
     *
     * @param {{ face: string, size: number, unit: number }} font @param {number} dpi
     */
    const spacingPixels = (font, dpi)=>{
        const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
            designCell(font.face));
        return pixelsOf(font.size, font.unit, dpi) * (cell.ascent + cell.descent)
            / cell.unitsPerEm;
    };

    /** @param {string} face */
    const generic = face=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [out])=>((out >>> 0) === 0 ? InvalidParameter
            : newFamily(face, out)),
    });

    return {
        /**
         * Status GdipCreateFontFamilyFromName(const WCHAR *name,
         *   GpFontCollection *collection, GpFontFamily **family)
         *
         * An outline face by name, substitutes followed; any other name, a
         * bitmap face's among them, is FontFamilyNotFound.
         */
        GdipCreateFontFamilyFromName: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, , out])=>{
                if ((name >>> 0) === 0 || (out >>> 0) === 0 || !host.readWideString)
                {
                    return InvalidParameter;
                }
                const face = outlineFace(host.readWideString(name >>> 0));
                return face === null || face === 'bitmap' ? FontFamilyNotFound
                    : newFamily(face, out);
            },
        },

        /** Status GdipGetGenericFontFamilySansSerif(GpFontFamily **family) */
        GdipGetGenericFontFamilySansSerif: generic(SANS_SERIF),
        /** Status GdipGetGenericFontFamilySerif(GpFontFamily **family) */
        GdipGetGenericFontFamilySerif: generic(SERIF),
        /** Status GdipGetGenericFontFamilyMonospace(GpFontFamily **family) */
        GdipGetGenericFontFamilyMonospace: generic(MONOSPACE),

        /** Status GdipCloneFontFamily(GpFontFamily *family, GpFontFamily **clone) */
        GdipCloneFontFamily: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                const face = families.get(family >>> 0);
                return face === undefined || (out >>> 0) === 0 ? InvalidParameter
                    : newFamily(face, out);
            },
        },

        /** Status GdipDeleteFontFamily(GpFontFamily *family) */
        GdipDeleteFontFamily: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([family])=>(families.delete(family >>> 0) ? Ok : InvalidParameter),
        },

        /** Status GdipGetFamilyName(GpFontFamily *family, WCHAR name[LF_FACESIZE], LANGID language) */
        GdipGetFamilyName: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                const face = families.get(family >>> 0);
                if (face === undefined || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const name = new Uint16Array(LF_FACESIZE);
                for (let i = 0; i < Math.min(face.length, LF_FACESIZE - 1); i++)
                {
                    name[i] = face.charCodeAt(i);
                }
                host.writeMemory(out >>> 0, new Uint8Array(name.buffer));
                return Ok;
            },
        },

        /**
         * Status GdipIsStyleAvailable(GpFontFamily *family, INT style, BOOL *available)
         *
         * Every style: GDI draws a face bold or italic it has no face of.
         */
        GdipIsStyleAvailable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([family, , out])=>{
                if (!families.has(family >>> 0) || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, 1);
                return Ok;
            },
        },

        /** Status GdipGetEmHeight(GpFontFamily *family, INT style, UINT16 *em) */
        GdipGetEmHeight: familyMetric('unitsPerEm'),
        /** Status GdipGetCellAscent(GpFontFamily *family, INT style, UINT16 *ascent) */
        GdipGetCellAscent: familyMetric('ascent'),
        /** Status GdipGetCellDescent(GpFontFamily *family, INT style, UINT16 *descent) */
        GdipGetCellDescent: familyMetric('descent'),
        /** Status GdipGetLineSpacing(GpFontFamily *family, INT style, UINT16 *spacing): the cell. */
        GdipGetLineSpacing: familyMetric('spacing'),

        /**
         * Status GdipCreateFont(const GpFontFamily *family, REAL size, INT style,
         *   Unit unit, GpFont **font)
         */
        GdipCreateFont: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([family, size, style, unit, out])=>{
                const face = families.get(family >>> 0);
                const em = real(size);
                if (face === undefined || (out >>> 0) === 0 || !(em > 0)
                    || (unit >>> 0) === UnitDisplay || (unit >>> 0) > UnitMillimeter)
                {
                    return InvalidParameter;
                }
                return newFont({ face, size: em, style: style & 0xf, unit: unit >>> 0 }, out);
            },
        },

        /** Status GdipCreateFontFromLogfontW(HDC hdc, const LOGFONTW *logfont, GpFont **font) */
        GdipCreateFontFromLogfontW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, logfont, out])=>{
                if ((hdc >>> 0) === 0 || (logfont >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const { view, name } = readLogfont(logfont, true);
                return fromLogfont(view, name, out);
            },
        },

        /** Status GdipCreateFontFromLogfontA(HDC hdc, const LOGFONTA *logfont, GpFont **font) */
        GdipCreateFontFromLogfontA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, logfont, out])=>{
                if ((hdc >>> 0) === 0 || (logfont >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                const { view, name } = readLogfont(logfont, false);
                return fromLogfont(view, name, out);
            },
        },

        /**
         * Status GdipCreateFontFromDC(HDC hdc, GpFont **font): the font the DC
         * has selected, as its LOGFONT describes it.
         */
        GdipCreateFontFromDC: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hdc, out])=>{
                if ((hdc >>> 0) === 0 || (out >>> 0) === 0 || !host.gdi32)
                {
                    return InvalidParameter;
                }
                // OBJ_FONT; then GetObjectW of a LOGFONTW's size.
                const font = host.gdi32('GetCurrentObject', [hdc >>> 0, 6]);
                const at = host.allocate(LF_FACE + LF_FACESIZE * 2);
                if (at === 0)
                {
                    return OutOfMemory;
                }
                try
                {
                    if (font === 0 || host.gdi32('GetObjectW', [font, LF_FACE + LF_FACESIZE * 2,
                        at]) === 0)
                    {
                        return InvalidParameter;
                    }
                    const { view, name } = readLogfont(at, true);
                    return fromLogfont(view, name, out);
                }
                finally
                {
                    host.free(at);
                }
            },
        },

        /** Status GdipCloneFont(GpFont *font, GpFont **clone) */
        GdipCloneFont: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([font, out])=>{
                const held = fonts.get(font >>> 0);
                return !held || (out >>> 0) === 0 ? InvalidParameter : newFont(held, out);
            },
        },

        /** Status GdipDeleteFont(GpFont *font) */
        GdipDeleteFont: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([font])=>(fonts.delete(font >>> 0) ? Ok : InvalidParameter),
        },

        /** Status GdipGetFamily(GpFont *font, GpFontFamily **family): a family of its own. */
        GdipGetFamily: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([font, out])=>{
                const held = fonts.get(font >>> 0);
                return !held || (out >>> 0) === 0 ? InvalidParameter : newFamily(held.face, out);
            },
        },

        /** Status GdipGetFontSize(GpFont *font, REAL *size): the em, in the font's unit. */
        GdipGetFontSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([font, out])=>{
                const held = fonts.get(font >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putFloat(out, held.size);
                return Ok;
            },
        },

        /** Status GdipGetFontStyle(GpFont *font, INT *style) */
        GdipGetFontStyle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([font, out])=>{
                const held = fonts.get(font >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, held.style);
                return Ok;
            },
        },

        /** Status GdipGetFontUnit(GpFont *font, Unit *unit) */
        GdipGetFontUnit: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([font, out])=>{
                const held = fonts.get(font >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putU32(out, held.unit);
                return Ok;
            },
        },

        /**
         * Status GdipGetFontHeightGivenDPI(const GpFont *font, REAL dpi, REAL *height):
         * the line spacing, in pixels at that resolution.
         */
        GdipGetFontHeightGivenDPI: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([font, dpi, out])=>{
                const held = fonts.get(font >>> 0);
                if (!held || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putFloat(out, spacingPixels(held, real(dpi)));
                return Ok;
            },
        },

        /**
         * Status GdipGetFontHeight(const GpFont *font, const GpGraphics *graphics,
         *   REAL *height)
         *
         * The line spacing in the graphics' unit - pixels, a graphics here
         * drawing at the display's resolution in its own; without one, in the
         * font's own unit.
         */
        GdipGetFontHeight: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([font, target, out])=>{
                const held = fonts.get(font >>> 0);
                if (!held || (out >>> 0) === 0
                    || ((target >>> 0) !== 0 && !isGraphics(target >>> 0)))
                {
                    return InvalidParameter;
                }
                const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
                    designCell(held.face));
                putFloat(out, (target >>> 0) !== 0 ? spacingPixels(held, DPI)
                    : held.size * (cell.ascent + cell.descent) / cell.unitsPerEm);
                return Ok;
            },
        },

        /** Status GdipGetLogFontW(GpFont *font, GpGraphics *graphics, LOGFONTW *logfont) */
        GdipGetLogFontW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([font, , out])=>toLogfont(font, out, true),
        },

        /** Status GdipGetLogFontA(GpFont *font, GpGraphics *graphics, LOGFONTA *logfont) */
        GdipGetLogFontA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([font, , out])=>toLogfont(font, out, false),
        },

        /** Status GdipGetDpiX(GpGraphics *graphics, REAL *dpi) */
        GdipGetDpiX: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([target, out])=>{
                if (!isGraphics(target >>> 0) || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putFloat(out, DPI);
                return Ok;
            },
        },

        /** Status GdipGetDpiY(GpGraphics *graphics, REAL *dpi) */
        GdipGetDpiY: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([target, out])=>{
                if (!isGraphics(target >>> 0) || (out >>> 0) === 0)
                {
                    return InvalidParameter;
                }
                putFloat(out, DPI);
                return Ok;
            },
        },
    };
}

