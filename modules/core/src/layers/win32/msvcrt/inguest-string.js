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
 *
 * and in a 64-bit process, where the pointer and the two counts are eight
 * bytes: a first word the handler (`msvcp80.js`) clears as it makes a string,
 * the buffer at +8, the length at +24 and the capacity at +32, forty bytes in
 * all. Each member takes its offsets by `pointerBytes` (the buffer one
 * pointer in, the length 16 bytes past it, the capacity a pointer past
 * that). It reads a count's low half, and writes the upper half as well only
 * where it makes the object, which held nothing before: a string of four
 * billion characters is none these members take, and the pointer's upper
 * half is zero for any text in the guest's memory.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').ptr} ptr */

export const STRING_BUFFER = 4;
export const STRING_SIZE = 20;
export const STRING_RESERVED = 24;
/** The same three in a 64-bit process. */
export const STRING_BUFFER_64 = 8;
export const STRING_SIZE_64 = 24;
export const STRING_RESERVED_64 = 32;
/** The inline buffer's capacity: sixteen bytes, the terminator among them. */
export const STRING_INLINE = 15;

/**
 * basic_string::basic_string()
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self
 * @returns {ptr}
 */
export function stringConstruct({ setU8, setU32, pointerBytes }, self){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    setU32(self + atReserved, STRING_INLINE);
    setU32(self + atSize, 0);
    if (pointerBytes === 8)
    {
        setU32(self, 0);
        setU32(self + 4, 0);
        setU32(self + atReserved + 4, 0);
        setU32(self + atSize + 4, 0);
    }
    setU8(self + atBuffer, 0);
    return self;
}

/**
 * basic_string::basic_string(const char *text)
 *
 * Inline when the text fits; the host's when it does not.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self @param {ptr} text
 * @returns {ptr}
 */
export function stringFromText({ u8, setU32, copyUp, host, pointerBytes }, self, text){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
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
    copyUp(self + atBuffer, text, length + 1);
    setU32(self + atSize, length);
    setU32(self + atReserved, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self, 0);
        setU32(self + 4, 0);
        setU32(self + atSize + 4, 0);
        setU32(self + atReserved + 4, 0);
    }
    return self;
}

/**
 * basic_string::basic_string(const basic_string &other)
 *
 * A copy's capacity is its own: inline when the other's text fits.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self @param {ptr} other
 * @returns {ptr}
 */
export function stringCopy({ u32, setU32, copyUp, host, pointerBytes, ptr }, self, other){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    const length = u32(other + atSize);
    if (length > STRING_INLINE)
    {
        return host();
    }
    const from = u32(other + atReserved) > STRING_INLINE ? ptr(other + atBuffer)
        : other + atBuffer;
    copyUp(self + atBuffer, from, length + 1);
    setU32(self + atSize, length);
    setU32(self + atReserved, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self, 0);
        setU32(self + 4, 0);
        setU32(self + atSize + 4, 0);
        setU32(self + atReserved + 4, 0);
    }
    return self;
}

/**
 * basic_string::~basic_string()
 *
 * Left empty and inline, as the library leaves it; a string with its text on
 * the heap is the host's, which frees it.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringDestroy({ u32, setU8, setU32, host, pointerBytes }, self){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    if (u32(self + atReserved) > STRING_INLINE)
    {
        return host();
    }
    setU32(self + atReserved, STRING_INLINE);
    setU32(self + atSize, 0);
    setU8(self + atBuffer, 0);
    return 0;
}

/**
 * const char *basic_string::c_str() const, and the address of the character
 * at an index -- `operator[]` in the forms that do not check it.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self
 * @returns {ptr}
 */
export function stringText({ u32, pointerBytes, ptr }, self){
    const atBuffer = pointerBytes;
    const atReserved = pointerBytes * 2 + 16;
    return u32(self + atReserved) > STRING_INLINE ? ptr(self + atBuffer)
        : self + atBuffer;
}

/**
 * char &basic_string::operator[](size_type index), unchecked.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self @param {u32} index
 * @returns {ptr}
 */
export function stringAt({ u32, pointerBytes, ptr }, self, index){
    const atBuffer = pointerBytes;
    const atReserved = pointerBytes * 2 + 16;
    const text = u32(self + atReserved) > STRING_INLINE ? ptr(self + atBuffer)
        : self + atBuffer;
    return text + index;
}

/**
 * size_type basic_string::size() const
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self
 * @returns {u32}
 */
export function stringSize({ u32, pointerBytes }, self){
    const atSize = pointerBytes + 16;
    return u32(self + atSize);
}

/**
 * basic_string &basic_string::operator+=(char c)
 *
 * Within the capacity here; past it the host's, which grows the string.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self @param {u32} c
 * @returns {ptr}
 */
export function stringAppendChar({ u32, setU8, setU32, host, pointerBytes, ptr }, self, c){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    const length = u32(self + atSize);
    const reserved = u32(self + atReserved);
    if (length >= reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE ? ptr(self + atBuffer)
        : self + atBuffer;
    setU8(text + length, c & 0xff);
    setU8(text + length + 1, 0);
    setU32(self + atSize, length + 1);
    return self;
}

/**
 * void basic_string::resize(size_type count)
 *
 * Cut to the count, or padded with zeros to it, within the capacity; past
 * it the host's.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {ptr} self @param {u32} count
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringResize({ u32, setU8, setU32, host, pointerBytes, ptr }, self, count){
    const atBuffer = pointerBytes;
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    const reserved = u32(self + atReserved);
    if (count > reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE ? ptr(self + atBuffer)
        : self + atBuffer;
    for (let at = u32(self + atSize); at < count; at++)
    {
        setU8(text + at, 0);
    }
    setU8(text + count, 0);
    setU32(self + atSize, count);
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
 * @param {Guest} guest @param {ptr} self @param {u32} count
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringReserve({ u32, host, pointerBytes }, self, count){
    const atSize = pointerBytes + 16;
    const atReserved = pointerBytes * 2 + 16;
    const reserved = u32(self + atReserved);
    if (count < u32(self + atSize) || count === reserved)
    {
        return 0;
    }
    if (count > reserved || reserved > STRING_INLINE && count <= STRING_INLINE)
    {
        return host();
    }
    return 0;
}
