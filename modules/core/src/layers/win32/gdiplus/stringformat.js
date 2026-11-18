/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s string formats: how text is laid in a rectangle - its flags,
 * alignment along and across lines, trimming, hotkey prefix, tab stops,
 * digit substitution and the character ranges MeasureCharacterRanges
 * measures. The two generic formats are one object each, the same however
 * often a program asks for them, changed by whoever changes them and never
 * deleted - as GDI+'s are.
 */

import { Status, fn } from './kit.js';

/** StringFormatFlags of the generic typographic format. */
const TYPOGRAPHIC_FLAGS = 0x4 | 0x2000 | 0x4000;
/** StringTrimming. */
const StringTrimmingNone = 0;
const StringTrimmingCharacter = 1;
/** StringDigitSubstitute. */
const StringDigitSubstituteUser = 0;
/** How many character ranges a format measures at most. */
const MAX_RANGES = 32;

/**
 * @typedef {Object} StringFormat
 * @property {number} flags @property {number} align @property {number} lineAlign
 * @property {number} trimming @property {number} hotkey
 * @property {number} tabFirst @property {number[]} tabs
 * @property {number} digitLanguage @property {number} digitSubstitute
 * @property {[number, number][]} ranges  first character and length of each
 * @property {boolean} typographic  whether lines are laid without GDI+'s padding
 * @property {boolean} generic  one of the generic formats, never deleted
 */

/** @param {number} flags @param {boolean} typographic @returns {StringFormat} */
const fresh = (flags, typographic)=>({ flags, align: 0, lineAlign: 0,
    trimming: typographic ? StringTrimmingNone : StringTrimmingCharacter, hotkey: 0, tabFirst: 0,
    tabs: [], digitLanguage: 0, digitSubstitute: StringDigitSubstituteUser, ranges: [],
    typographic, generic: false });

/** @param {import('./kit.js').Kit} kit */
export function createStringFormatFunctions(kit){
    const { Ok, InvalidParameter, NotImplemented, ValueOverflow } = Status;
    /** @param {number} at @returns {StringFormat | undefined} */
    const get = at=>kit.get(at, 'format');
    /** @type {Record<'default' | 'typographic', number>} */
    const generics = { default: 0, typographic: 0 };
    /** @param {'default' | 'typographic'} which @param {number} out */
    const generic = (which, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        if (generics[which] === 0)
        {
            const format = which === 'typographic' ? fresh(TYPOGRAPHIC_FLAGS, true)
                : fresh(0, false);
            format.generic = true;
            generics[which] = kit.add('format', format);
        }
        kit.putPointer(out, generics[which]);
        return Ok;
    };
    /**
     * @param {(format: StringFormat, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onFormat = body=>([at, ...rest])=>{
        const format = get(at);
        return format ? body(format, rest) : InvalidParameter;
    };
    /** @param {keyof StringFormat} key @param {number} high */
    const setter = (key, high)=>fn(8, onFormat((format, [value])=>{
        if ((value >>> 0) > high)
        {
            return InvalidParameter;
        }
        /** @type {any} */ (format)[key] = value >>> 0;
        return Ok;
    }));
    /** @param {keyof StringFormat} key */
    const getter = key=>fn(8, onFormat((format, [out])=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.putU32(out, /** @type {number} */ (format[key]));
        return Ok;
    }));

    const functions = {
        /**
         * Status GdipCreateStringFormat(INT flags, LANGID language, GpStringFormat **format)
         *
         * The language is not kept: digits substitute as the user's do.
         */
        GdipCreateStringFormat: fn(12, ([flags, , out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('format', fresh(flags >>> 0, false), out);
            return Ok;
        }),
        /** Status GdipStringFormatGetGenericDefault(GpStringFormat **format) */
        GdipStringFormatGetGenericDefault: fn(4, ([out])=>generic('default', out)),
        /** Status GdipStringFormatGetGenericTypographic(GpStringFormat **format) */
        GdipStringFormatGetGenericTypographic: fn(4, ([out])=>generic('typographic', out)),
        /** Status GdipCloneStringFormat(const GpStringFormat *format, GpStringFormat **clone) */
        GdipCloneStringFormat: fn(8, onFormat((format, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('format', { ...format, tabs: [...format.tabs],
                ranges: format.ranges.map(([a, b])=>[a, b]), generic: false }, out);
            return Ok;
        })),
        /** Status GdipDeleteStringFormat(GpStringFormat *format): a generic one stays. */
        GdipDeleteStringFormat: fn(4, ([at])=>{
            const format = get(at);
            if (!format)
            {
                return InvalidParameter;
            }
            if (!format.generic)
            {
                kit.remove(at, 'format');
            }
            return Ok;
        }),
        /** Status GdipSetStringFormatFlags(GpStringFormat *format, INT flags) */
        GdipSetStringFormatFlags: fn(8, onFormat((format, [flags])=>{
            format.flags = flags >>> 0;
            return Ok;
        })),
        /** Status GdipGetStringFormatFlags(const GpStringFormat *format, INT *flags) */
        GdipGetStringFormatFlags: getter('flags'),
        /** Status GdipSetStringFormatAlign(GpStringFormat *format, StringAlignment align) */
        GdipSetStringFormatAlign: setter('align', 2),
        /** Status GdipGetStringFormatAlign(const GpStringFormat *format, StringAlignment *align) */
        GdipGetStringFormatAlign: getter('align'),
        /** Status GdipSetStringFormatLineAlign(GpStringFormat *format, StringAlignment align) */
        GdipSetStringFormatLineAlign: setter('lineAlign', 2),
        /** Status GdipGetStringFormatLineAlign(const GpStringFormat *, StringAlignment *) */
        GdipGetStringFormatLineAlign: getter('lineAlign'),
        /** Status GdipSetStringFormatTrimming(GpStringFormat *format, StringTrimming trimming) */
        GdipSetStringFormatTrimming: setter('trimming', 5),
        /** Status GdipGetStringFormatTrimming(GpStringFormat *format, StringTrimming *trimming) */
        GdipGetStringFormatTrimming: getter('trimming'),
        /** Status GdipSetStringFormatHotkeyPrefix(GpStringFormat *format, INT prefix) */
        GdipSetStringFormatHotkeyPrefix: setter('hotkey', 2),
        /** Status GdipGetStringFormatHotkeyPrefix(const GpStringFormat *format, INT *prefix) */
        GdipGetStringFormatHotkeyPrefix: getter('hotkey'),
        /**
         * Status GdipSetStringFormatTabStops(GpStringFormat *format, REAL firstTabOffset,
         *   INT count, const REAL *tabStops)
         *
         * A negative first offset with stops is NotImplemented, as GDI+
         * answers; a negative count sets nothing.
         */
        GdipSetStringFormatTabStops: fn(16, onFormat((format, [first, count, tabs])=>{
            if ((tabs >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const offset = kit.real(first);
            if ((count | 0) <= 0)
            {
                return Ok;
            }
            if (offset < 0)
            {
                return NotImplemented;
            }
            format.tabFirst = offset;
            format.tabs = kit.f32s(tabs, count | 0);
            return Ok;
        }), { floats: { 1: 'f32' } }),
        /**
         * Status GdipGetStringFormatTabStops(const GpStringFormat *format, INT count,
         *   REAL *firstTabOffset, REAL *tabStops)
         */
        GdipGetStringFormatTabStops: fn(16, onFormat((format, [count, first, tabs])=>{
            if ((first >>> 0) === 0 || (tabs >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(first, format.tabFirst);
            if ((count | 0) > 0)
            {
                kit.putF32s(tabs, format.tabs.slice(0, count | 0));
            }
            return Ok;
        })),
        /** Status GdipGetStringFormatTabStopCount(const GpStringFormat *format, INT *count) */
        GdipGetStringFormatTabStopCount: fn(8, onFormat((format, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, format.tabs.length);
            return Ok;
        })),
        /**
         * Status GdipSetStringFormatDigitSubstitution(GpStringFormat *format, LANGID language,
         *   StringDigitSubstitute substitute)
         */
        GdipSetStringFormatDigitSubstitution: fn(12, onFormat((format, [language, substitute])=>{
            format.digitLanguage = language & 0xffff;
            format.digitSubstitute = substitute >>> 0;
            return Ok;
        })),
        /**
         * Status GdipGetStringFormatDigitSubstitution(const GpStringFormat *format,
         *   LANGID *language, StringDigitSubstitute *substitute): either may be NULL.
         */
        GdipGetStringFormatDigitSubstitution: fn(12, onFormat((format, [language, substitute])=>{
            if ((language >>> 0) !== 0)
            {
                kit.write(language, new Uint8Array(Uint16Array.of(format.digitLanguage).buffer));
            }
            if ((substitute >>> 0) !== 0)
            {
                kit.putU32(substitute, format.digitSubstitute);
            }
            return Ok;
        })),
        /**
         * Status GdipSetStringFormatMeasurableCharacterRanges(GpStringFormat *format,
         *   INT count, const CharacterRange *ranges): 32 at most.
         */
        GdipSetStringFormatMeasurableCharacterRanges: fn(12, onFormat((format, [count, ranges])=>{
            if ((count | 0) > 0 && (ranges >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) > MAX_RANGES)
            {
                return ValueOverflow;
            }
            const values = (count | 0) > 0 ? kit.i32s(ranges, (count | 0) * 2) : [];
            format.ranges = Array.from({ length: Math.max(0, count | 0) }, (_, i)=>
                /** @type {[number, number]} */ ([values[i * 2], values[i * 2 + 1]]));
            return Ok;
        })),
        /**
         * Status GdipGetStringFormatMeasurableCharacterRangeCount(const GpStringFormat *format,
         *   INT *count)
         */
        GdipGetStringFormatMeasurableCharacterRangeCount: fn(8, onFormat((format, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, format.ranges.length);
            return Ok;
        })),
    };
    /** The generic default format, made once: what a call with no format lays text by. */
    const defaultFormat = ()=>{
        if (generics.default === 0)
        {
            const format = fresh(0, false);
            format.generic = true;
            generics.default = kit.add('format', format);
        }
        return /** @type {StringFormat} */ (get(generics.default));
    };
    return { functions, get, defaultFormat };
}
