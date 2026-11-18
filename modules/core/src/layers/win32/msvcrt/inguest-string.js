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
 * and under a 64-bit compiler in forty bytes, quadword pointers and sizes:
 *
 *   +0   eight bytes the library zeroes (the allocator, padded)
 *   +8   the inline buffer, or the pointer to the text
 *   +24  the length
 *   +32  the capacity
 *
 * Each function takes the layout from `pointerBytes`, so the i386 and the
 * x86-64 come from the one source; a length or a capacity written at 64 bits
 * is written whole, its upper half zero. A size a 64-bit caller passes is
 * read as its low half, as the host's handler reads it. Nothing is written
 * before a call is handed over: the host's member builds the string whole.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').u32} u32 */

export const STRING_BUFFER = 4;
export const STRING_SIZE = 20;
export const STRING_RESERVED = 24;
/** The same three in the 64-bit layout. */
export const LONG_STRING_BUFFER = 8;
export const LONG_STRING_SIZE = 24;
export const LONG_STRING_RESERVED = 32;
/** The inline buffer's capacity: sixteen bytes, the terminator among them. */
export const STRING_INLINE = 15;

/**
 * basic_string::basic_string()
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function stringConstruct({ setU8, setU32, pointerBytes }, self){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    if (pointerBytes === 8)
    {
        // The allocator's eight bytes, as the library's constructor leaves them.
        setU32(self, 0);
        setU32(self + 4, 0);
    }
    setU32(self + capacityAt, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self + capacityAt + 4, 0);
    }
    setU32(self + lengthAt, 0);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
    setU8(self + bufferAt, 0);
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
export function stringFromText({ u8, setU32, copyUp, host, pointerBytes }, self, text){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
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
    if (pointerBytes === 8)
    {
        // The allocator's eight bytes, as the library's constructor leaves them.
        setU32(self, 0);
        setU32(self + 4, 0);
    }
    copyUp(self + bufferAt, text, length + 1);
    setU32(self + lengthAt, length);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
    setU32(self + capacityAt, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self + capacityAt + 4, 0);
    }
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
export function stringCopy({ u32, setU32, copyUp, host, pointerBytes }, self, other){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    const length = u32(other + lengthAt);
    if (length > STRING_INLINE)
    {
        return host();
    }
    const from = u32(other + capacityAt) > STRING_INLINE
        ? u32(other + bufferAt) : (other + bufferAt) >>> 0;
    if (pointerBytes === 8)
    {
        // The allocator's eight bytes, as the library's constructor leaves them.
        setU32(self, 0);
        setU32(self + 4, 0);
    }
    copyUp(self + bufferAt, from, length + 1);
    setU32(self + lengthAt, length);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
    setU32(self + capacityAt, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self + capacityAt + 4, 0);
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
 * @param {Guest} guest @param {u32} self
 * @returns {u32}  Nothing a caller reads: zero.
 */
export function stringDestroy({ u32, setU8, setU32, host, pointerBytes }, self){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    if (u32(self + capacityAt) > STRING_INLINE)
    {
        return host();
    }
    setU32(self + capacityAt, STRING_INLINE);
    if (pointerBytes === 8)
    {
        setU32(self + capacityAt + 4, 0);
    }
    setU32(self + lengthAt, 0);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
    setU8(self + bufferAt, 0);
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
export function stringText({ u32, pointerBytes }, self){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    return u32(self + capacityAt) > STRING_INLINE
        ? u32(self + bufferAt) : (self + bufferAt) >>> 0;
}

/**
 * char &basic_string::operator[](size_type index), unchecked.
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self @param {u32} index
 * @returns {u32}
 */
export function stringAt({ u32, pointerBytes }, self, index){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    const text = u32(self + capacityAt) > STRING_INLINE
        ? u32(self + bufferAt) : (self + bufferAt) >>> 0;
    return (text + index) >>> 0;
}

/**
 * size_type basic_string::size() const
 *
 * @guestCode thiscall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function stringSize({ u32, pointerBytes }, self){
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    return u32(self + lengthAt);
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
export function stringAppendChar({ u32, setU8, setU32, host, pointerBytes }, self, c){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    const length = u32(self + lengthAt);
    const reserved = u32(self + capacityAt);
    if (length >= reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE
        ? u32(self + bufferAt) : (self + bufferAt) >>> 0;
    setU8(text + length, c & 0xff);
    setU8(text + length + 1, 0);
    setU32(self + lengthAt, length + 1);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
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
export function stringResize({ u32, setU8, setU32, host, pointerBytes }, self, count){
    const bufferAt = pointerBytes === 8 ? LONG_STRING_BUFFER : STRING_BUFFER;
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    const reserved = u32(self + capacityAt);
    if (count > reserved)
    {
        return host();
    }
    const text = reserved > STRING_INLINE
        ? u32(self + bufferAt) : (self + bufferAt) >>> 0;
    for (let at = u32(self + lengthAt); at < count; at++)
    {
        setU8(text + at, 0);
    }
    setU8(text + count, 0);
    setU32(self + lengthAt, count);
    if (pointerBytes === 8)
    {
        setU32(self + lengthAt + 4, 0);
    }
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
export function stringReserve({ u32, host, pointerBytes }, self, count){
    const lengthAt = pointerBytes === 8 ? LONG_STRING_SIZE : STRING_SIZE;
    const capacityAt = pointerBytes === 8 ? LONG_STRING_RESERVED : STRING_RESERVED;
    const reserved = u32(self + capacityAt);
    if (count < u32(self + lengthAt) || count === reserved)
    {
        return 0;
    }
    if (count > reserved || reserved > STRING_INLINE && count <= STRING_INLINE)
    {
        return host();
    }
    return 0;
}
