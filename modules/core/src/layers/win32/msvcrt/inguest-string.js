/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `std::basic_string<char>` of the Visual C++ 2005 library (MSVCP80.DLL), the
 * members a program calls in its inner loops, run in the guest: each is a few
 * loads and stores, and a crossing into the host for each would cost more
 * than the member does. What needs memory allocated or freed -- a string
 * outgrowing its capacity, one leaving the inline buffer -- goes to the host
 * (`return host()`), whose handler (`msvcp80.js`) holds the whole member.
 *
 * The object, as the library lays it out for a release build:
 *
 *   +0   the allocator (empty, its four bytes unused)
 *   +4   sixteen bytes of inline buffer, or the pointer to the text when
 *        the capacity is 16 or more
 *   +20  the length
 *   +24  the capacity, the terminator not counted: 15 while inline
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').u32} u32 */

export const STRING_BUFFER = 4;
export const STRING_SIZE = 20;
export const STRING_RESERVED = 24;
/** The inline buffer's capacity: sixteen bytes, the terminator among them. */
export const STRING_INLINE = 15;

/**
 * basic_string::basic_string()
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function stringConstruct({ setU8, setU32 }, self){
    setU32(self + STRING_RESERVED, STRING_INLINE);
    setU32(self + STRING_SIZE, 0);
    setU8(self + STRING_BUFFER, 0);
    return self;
}

/**
 * basic_string::basic_string(const char *text)
 *
 * Inline when the text fits; the host's when it does not.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} text
 * @returns {u32}
 */
export function stringFromText({ u8, setU32, copyUp, host }, self, text){
    /** @type {u32} */
    let length = 0;
    while (u8(text + length) !== 0)
    {
        length++;
        if (length > STRING_INLINE)
        {
            return host();
        }
    }
    copyUp(self + STRING_BUFFER, text, length + 1);
    setU32(self + STRING_SIZE, length);
    setU32(self + STRING_RESERVED, STRING_INLINE);
    return self;
}

/**
 * basic_string::basic_string(const basic_string &other)
 *
 * A copy's capacity is its own: inline when the other's text fits.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} other
 * @returns {u32}
 */
export function stringCopy({ u32, setU32, copyUp, host }, self, other){
    const length = u32(other + STRING_SIZE);
    if (length > STRING_INLINE)
    {
        return host();
    }
    const from = u32(other + STRING_RESERVED) > STRING_INLINE
        ? u32(other + STRING_BUFFER) : (other + STRING_BUFFER) >>> 0;
    copyUp(self + STRING_BUFFER, from, length + 1);
    setU32(self + STRING_SIZE, length);
    setU32(self + STRING_RESERVED, STRING_INLINE);
    return self;
}

/**
 * basic_string::~basic_string()
 *
 * Left empty and inline, as the library leaves it; a string with its text on
 * the heap is the host's, which frees it.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringDestroy({ u32, setU8, setU32, host }, self){
    if (u32(self + STRING_RESERVED) > STRING_INLINE)
    {
        return host();
    }
    setU32(self + STRING_RESERVED, STRING_INLINE);
    setU32(self + STRING_SIZE, 0);
    setU8(self + STRING_BUFFER, 0);
    return 0;
}

/**
 * const char *basic_string::c_str() const, and the address of the character
 * at an index -- `operator[]` in the forms that do not check it.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function stringText({ u32 }, self){
    return u32(self + STRING_RESERVED) > STRING_INLINE
        ? u32(self + STRING_BUFFER) : (self + STRING_BUFFER) >>> 0;
}

/**
 * char &basic_string::operator[](size_type index), unchecked.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} index
 * @returns {u32}
 */
export function stringAt({ u32 }, self, index){
    const text = u32(self + STRING_RESERVED) > STRING_INLINE
        ? u32(self + STRING_BUFFER) : (self + STRING_BUFFER) >>> 0;
    return (text + index) >>> 0;
}

/**
 * size_type basic_string::size() const
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function stringSize({ u32 }, self){
    return u32(self + STRING_SIZE);
}

/**
 * basic_string &basic_string::operator+=(char c)
 *
 * Within the capacity here; past it the host's, which grows the string.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} c
 * @returns {u32}
 */
export function stringAppendChar({ u32, setU8, setU32, host }, self, c){
    const length = u32(self + STRING_SIZE);
    const reserved = u32(self + STRING_RESERVED);
    if (length >= reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE
        ? u32(self + STRING_BUFFER) : (self + STRING_BUFFER) >>> 0;
    setU8(text + length, c & 0xff);
    setU8(text + length + 1, 0);
    setU32(self + STRING_SIZE, length + 1);
    return self;
}

/**
 * void basic_string::resize(size_type count)
 *
 * Cut to the count, or padded with zeros to it, within the capacity; past
 * it the host's.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} count
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringResize({ u32, setU8, setU32, host }, self, count){
    const reserved = u32(self + STRING_RESERVED);
    if (count > reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE
        ? u32(self + STRING_BUFFER) : (self + STRING_BUFFER) >>> 0;
    for (let at = u32(self + STRING_SIZE); at < count; at++)
    {
        setU8(text + at, 0);
    }
    setU8(text + count, 0);
    setU32(self + STRING_SIZE, count);
    return 0;
}

/**
 * void basic_string::reserve(size_type count)
 *
 * Nothing to do for a count below the length or one the capacity already
 * holds without shrinking out of the heap; growing, or a heap string asked
 * to fit inline again, is the host's.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} count
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringReserve({ u32, host }, self, count){
    const reserved = u32(self + STRING_RESERVED);
    if (count < u32(self + STRING_SIZE) || count === reserved)
    {
        return 0;
    }
    if (count > reserved || reserved > STRING_INLINE && count <= STRING_INLINE)
    {
        return host();
    }
    return 0;
}
