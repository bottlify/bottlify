/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A decode-only zstd (RFC 8878) of this project's own, freestanding C: no
 * libc, no allocation, no dictionaries. It is the same algorithm as
 * `modules/core/src/zstd.js`, function for function, so the two can be judged
 * against each other byte for byte; this one is compiled to WebAssembly by
 * `build-zstd.sh` and answers a guest file read synchronously at the speed the
 * emulator's decoder had.
 *
 * Interface (every pointer is an offset into the module's exported memory):
 *
 *   int32_t zstd_decompress(const uint8_t* in, uint32_t inLength,
 *                           uint8_t* out, uint32_t outCapacity);
 *     Decodes every frame of `in` into `out` and answers the bytes written, or
 *     a negative code: ZSTD_E_CORRUPT, ZSTD_E_UNSUPPORTED (a dictionary, a
 *     window past 128 MiB, a reserved block), ZSTD_E_TRUNCATED (the input ended
 *     inside a frame), ZSTD_E_OUTPUT (the output does not fit).
 *
 *   uint32_t zstd_version(void);   the interface version, 1.
 *
 * The working buffers are static: the literals of one block (128 KiB, the
 * format's block limit), one Huffman table, three FSE tables and the weights.
 * A window is the output itself -- a match copies from what was already
 * written -- so no window buffer exists, and a frame's output must fit in
 * `out` whole, which a bundle block's does by construction.
 */

#include <stdint.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int32_t i32;

#define ZSTD_E_CORRUPT (-1)
#define ZSTD_E_UNSUPPORTED (-2)
#define ZSTD_E_TRUNCATED (-3)
#define ZSTD_E_OUTPUT (-4)

#define MAGIC 0xfd2fb528u
#define SKIPPABLE_MASK 0xfffffff0u
#define SKIPPABLE 0x184d2a50u
#define MAX_WINDOW (128u * 1024u * 1024u)
#define BLOCK_MAX (128u * 1024u)
#define HUFFMAN_MAX_BITS 12
#define FSE_MAX_LOG 9

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name)
#endif

/* --- the small libc the compiler may call for, provided here ------------ */

#ifdef __wasm__
void* memcpy(void* dst, const void* src, unsigned long n){
    u8* d = (u8*)dst;
    const u8* s = (const u8*)src;
    while (n--) *d++ = *s++;
    return dst;
}

void* memset(void* dst, int value, unsigned long n){
    u8* d = (u8*)dst;
    while (n--) *d++ = (u8)value;
    return dst;
}
#endif

static void fill_u16(u16* at, u16 value, u32 count){
    while (count--) *at++ = value;
}

static void zero_u32(u32* at, u32 count){
    while (count--) *at++ = 0;
}

static void copy_forward(u8* dst, const u8* src, u32 n){
    /* A byte at a time on purpose: a match whose offset is shorter than its
     * length reads what it just wrote, which is the format's run encoding. */
    while (n--) *dst++ = *src++;
}

static u32 high_bit(u32 value){
    u32 bit = 0;
    while (value >>= 1) bit++;
    return bit;
}

static u32 read_u16(const u8* at){
    return (u32)at[0] | ((u32)at[1] << 8);
}

static u32 read_u24(const u8* at){
    return (u32)at[0] | ((u32)at[1] << 8) | ((u32)at[2] << 16);
}

static u32 read_u32(const u8* at){
    return (u32)at[0] | ((u32)at[1] << 8) | ((u32)at[2] << 16) | ((u32)at[3] << 24);
}

/* --- the bit readers ---------------------------------------------------- */

/* Forward, from a byte offset: the FSE distributions are read this way. */
typedef struct {
    const u8* bytes;
    u32 size;
    u32 bit;
} Forward;

static u32 forward_peek(const Forward* f, u32 n){
    u32 base = f->bit >> 3;
    u32 shift = f->bit & 7;
    u64 word = 0;
    u32 i;
    for (i = 0; i < 5; i++)
    {
        u32 at = base + i;
        if (at < f->size) word |= (u64)f->bytes[at] << (8 * i);
    }
    word >>= shift;
    return n >= 32 ? (u32)word : (u32)(word & (((u64)1 << n) - 1));
}

static u32 forward_read(Forward* f, u32 n){
    u32 value = forward_peek(f, n);
    f->bit += n;
    return value;
}

/* Backward, from the marker bit at the end: Huffman streams, weights, the
 * sequences. `bit` is the number of bits left below the marker. */
typedef struct {
    const u8* bytes;
    u32 size;
    i32 bit;
} Reverse;

static int reverse_init(Reverse* r, const u8* bytes, u32 size){
    r->bytes = bytes;
    r->size = size;
    r->bit = 0;
    if (size > 0)
    {
        u8 last = bytes[size - 1];
        if (last == 0) return ZSTD_E_CORRUPT;
        r->bit = (i32)(size - 1) * 8 + (i32)high_bit(last);
    }
    return 0;
}

/* The n bits from position p up, bit p the lowest; positions outside the
 * stream read as zero, as the reference reader has them. */
static u32 reverse_extract(const Reverse* r, i32 p, u32 n){
    i32 base = p >= 0 ? (p >> 3) : -((-p + 7) >> 3);
    u32 shift = (u32)(p - base * 8);
    u64 word = 0;
    u32 i;
    for (i = 0; i < 8; i++)
    {
        i32 at = base + (i32)i;
        if (at >= 0 && (u32)at < r->size) word |= (u64)r->bytes[at] << (8 * i);
    }
    word >>= shift;
    return n >= 32 ? (u32)word : (u32)(word & (((u64)1 << n) - 1));
}

static u32 reverse_peek(const Reverse* r, u32 n){
    return reverse_extract(r, r->bit - (i32)n, n);
}

static u32 reverse_read(Reverse* r, u32 n){
    u32 value = reverse_extract(r, r->bit - (i32)n, n);
    r->bit -= (i32)n;
    return value;
}

/* --- FSE ---------------------------------------------------------------- */

typedef struct {
    u32 log;          /* accuracy log; 0 with `rle` set */
    int rle;          /* 1 when the table is one symbol */
    u8 rleSymbol;
    u8 symbol[1 << FSE_MAX_LOG];
    u8 numBits[1 << FSE_MAX_LOG];
    i32 baseline[1 << FSE_MAX_LOG];
} FseTable;

/* Builds the table from the normalised counts, exactly as the reference does:
 * the "less than one" symbols take the top cells, the rest spread by the
 * step, then every cell's bits and baseline follow its symbol's next state. */
static void build_fse(FseTable* table, const i32* probs, u32 count, u32 log){
    u32 size = 1u << log;
    u32 high = size - 1;
    u32 next[256];
    u32 step = (size >> 1) + (size >> 3) + 3;
    u32 mask = size - 1;
    u32 position = 0;
    u32 symbol, i;
    zero_u32(next, 256);
    table->log = log;
    table->rle = 0;
    for (symbol = 0; symbol < count; symbol++)
    {
        if (probs[symbol] == -1)
        {
            table->symbol[high] = (u8)symbol;
            table->numBits[high] = (u8)log;
            table->baseline[high] = 0;
            high--;
            next[symbol] = 1;
        }
        else
        {
            next[symbol] = (u32)probs[symbol];
        }
    }
    for (symbol = 0; symbol < count; symbol++)
    {
        i32 n = probs[symbol];
        for (i = 0; n > 0 && i < (u32)n; i++)
        {
            table->symbol[position] = (u8)symbol;
            position = (position + step) & mask;
            while (position > high) position = (position + step) & mask;
        }
    }
    for (i = 0; i < size; i++)
    {
        u32 s = table->symbol[i];
        u32 state;
        if (i > high)
        {
            /* A "less than one" cell already carries its bits and baseline. */
            continue;
        }
        state = next[s]++;
        table->numBits[i] = (u8)(log - high_bit(state));
        table->baseline[i] = (i32)((state << table->numBits[i]) - size);
    }
}

typedef struct {
    i32 probs[256];
    u32 count;
    u32 log;
    u32 bytes;
} Distribution;

/* Reads a compressed distribution (the counts of an FSE table) from a forward
 * stream; answers 0 or an error. */
static int read_distribution(Forward* bits, u32 maxSymbol, u32 maxAccuracy, Distribution* d){
    u32 start = bits->bit;
    u32 log = forward_read(bits, 4) + 5;
    u32 size, remaining, threshold, nbBits, guard = 0;
    int previous0 = 0;
    if (log > maxAccuracy) return ZSTD_E_CORRUPT;
    size = 1u << log;
    remaining = size + 1;
    threshold = size;
    nbBits = log + 1;
    d->count = 0;
    d->log = log;
    while (remaining > 1 && d->count <= maxSymbol)
    {
        u32 max, count;
        i32 value;
        if (++guard > 4096) return ZSTD_E_CORRUPT;
        if (previous0)
        {
            u32 zeros = 0, flag;
            do
            {
                flag = forward_read(bits, 2);
                zeros += flag;
            }
            while (flag == 3);
            while (zeros-- > 0 && d->count <= maxSymbol) d->probs[d->count++] = 0;
        }
        max = (2 * threshold - 1) - remaining;
        if (forward_peek(bits, nbBits - 1) < max)
        {
            count = forward_peek(bits, nbBits - 1);
            bits->bit += nbBits - 1;
        }
        else
        {
            count = forward_peek(bits, nbBits);
            bits->bit += nbBits;
            if (count >= threshold) count -= max;
        }
        value = (i32)count - 1;
        remaining -= (u32)(value < 0 ? -value : value);
        if (d->count > 255) return ZSTD_E_CORRUPT;
        d->probs[d->count++] = value;
        previous0 = value == 0;
        while (remaining < threshold)
        {
            nbBits--;
            threshold >>= 1;
        }
    }
    d->bytes = ((bits->bit - start) + 7) >> 3;
    return 0;
}

static const i32 PREDEFINED_LL[36] = { 4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1 };
static const i32 PREDEFINED_ML[53] = { 1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
    -1, -1, -1, -1, -1 };
static const i32 PREDEFINED_OF[29] = { 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1 };

static const u32 LL_BASE[36] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
    8192, 16384, 32768, 65536 };
static const u8 LL_BITS[36] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
static const u32 ML_BASE[53] = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37,
    39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099,
    8195, 16387, 32771, 65539 };
static const u8 ML_BITS[53] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3,
    4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };

/* --- Huffman ------------------------------------------------------------ */

typedef struct {
    u16 packed[1 << HUFFMAN_MAX_BITS];  /* symbol | width << 8, by the next maxBits bits */
    u32 maxBits;
    int present;
} Huffman;

static FseTable weightTable;

/* Weights coded with FSE: the distribution first, then two interleaved
 * states over a backward stream, until it runs out. */
static int read_huffman_weights(const u8* bytes, u32 at, u32 size, u32 limit, u8* weights, u32* count){
    Forward forward;
    Distribution dist;
    Reverse stream;
    u32 log, n = 0, state1, state2;
    int error;
    forward.bytes = bytes;
    forward.size = limit;
    forward.bit = at * 8;
    error = read_distribution(&forward, 255, 6, &dist);
    if (error) return error;
    if (dist.bytes > size) return ZSTD_E_CORRUPT;
    build_fse(&weightTable, dist.probs, dist.count, dist.log);
    log = dist.log;
    error = reverse_init(&stream, bytes + at + dist.bytes, size - dist.bytes);
    if (error) return error;
    state1 = reverse_read(&stream, log);
    state2 = reverse_read(&stream, log);
    for (;;)
    {
        if (n + 2 > 255) return ZSTD_E_CORRUPT;
        weights[n++] = weightTable.symbol[state1];
        if (stream.bit < (i32)weightTable.numBits[state1])
        {
            weights[n++] = weightTable.symbol[state2];
            break;
        }
        state1 = (u32)(weightTable.baseline[state1] + (i32)reverse_read(&stream, weightTable.numBits[state1]));
        weights[n++] = weightTable.symbol[state2];
        if (stream.bit < (i32)weightTable.numBits[state2])
        {
            weights[n++] = weightTable.symbol[state1];
            break;
        }
        state2 = (u32)(weightTable.baseline[state2] + (i32)reverse_read(&stream, weightTable.numBits[state2]));
    }
    *count = n;
    return 0;
}

/* The table from the weights; the last symbol's weight is what makes the
 * total a power of two, as the format has it. */
static int build_huffman(Huffman* h, u8* weights, u32 count){
    u32 total = 0, maxBits, i, weight, next = 0;
    u32 countByWeight[HUFFMAN_MAX_BITS + 2];
    u32 start[HUFFMAN_MAX_BITS + 2];
    for (i = 0; i < count; i++)
    {
        if (weights[i] > 0) total += 1u << (weights[i] - 1);
    }
    if (total == 0) return ZSTD_E_CORRUPT;
    maxBits = high_bit(total) + 1;
    if (maxBits > HUFFMAN_MAX_BITS || count > 255) return ZSTD_E_CORRUPT;
    {
        u32 implied = (1u << maxBits) - total;
        u32 w = 0;
        while (implied > 1) { implied >>= 1; w++; }
        /* implied is a power of two by construction; its weight is log2 + 1 */
        weights[count++] = (u8)(w + 1);
    }
    for (i = 0; i <= HUFFMAN_MAX_BITS + 1; i++) { countByWeight[i] = 0; start[i] = 0; }
    for (i = 0; i < count; i++)
    {
        if (weights[i] > maxBits) return ZSTD_E_CORRUPT;
        if (weights[i] > 0) countByWeight[weights[i]]++;
    }
    for (weight = 1; weight <= maxBits; weight++)
    {
        start[weight] = next;
        next += countByWeight[weight] << (weight - 1);
    }
    if (next != (1u << maxBits)) return ZSTD_E_CORRUPT;
    for (i = 0; i < count; i++)
    {
        u32 run, width, from;
        weight = weights[i];
        if (weight == 0) continue;
        run = 1u << (weight - 1);
        width = maxBits + 1 - weight;
        from = start[weight];
        fill_u16(h->packed + from, (u16)(i | (width << 8)), run);
        start[weight] = from + run;
    }
    h->maxBits = maxBits;
    h->present = 1;
    return 0;
}

static u8 weightBuffer[257];

/* A tree as a compressed literals block carries one; answers its byte size
 * through `used`, or an error. */
static int read_huffman_tree(const u8* bytes, u32 at, u32 limit, Huffman* h, u32* used){
    u32 header, start = at, count = 0, i;
    int error;
    if (at >= limit) return ZSTD_E_TRUNCATED;
    header = bytes[at++];
    if (header >= 128)
    {
        u32 symbols = header - 127;
        if (at + ((symbols + 1) >> 1) > limit) return ZSTD_E_TRUNCATED;
        for (i = 0; i < symbols; i++)
        {
            u8 byte = bytes[at + (i >> 1)];
            weightBuffer[count++] = (i & 1) == 0 ? (u8)(byte >> 4) : (u8)(byte & 0x0f);
        }
        at += (symbols + 1) >> 1;
    }
    else
    {
        if (at + header > limit) return ZSTD_E_TRUNCATED;
        error = read_huffman_weights(bytes, at, header, limit, weightBuffer, &count);
        if (error) return error;
        at += header;
    }
    error = build_huffman(h, weightBuffer, count);
    if (error) return error;
    *used = at - start;
    return 0;
}

/* One Huffman-coded stream, read backward from `end`, `count` symbols into
 * `out`; the 32-bit accumulator holds the next bits with the newest at the top. */
static int decode_huffman_stream(const u8* bytes, u32 start, u32 end, const Huffman* h, u8* out, u32 count){
    u32 last, stop, acc, have, shift0, i;
    i32 at;
    const u16* packed = h->packed;
    if (count == 0) return 0;
    if (end <= start) return ZSTD_E_CORRUPT;
    last = bytes[end - 1];
    if (last == 0) return ZSTD_E_CORRUPT;
    stop = high_bit(last);
    at = (i32)end - 1;
    acc = stop == 0 ? 0 : ((u32)bytes[at] & ((1u << stop) - 1)) << (32 - stop);
    have = stop;
    shift0 = 32 - h->maxBits;
    at--;
    for (i = 0; i < count; i++)
    {
        u16 code;
        while (have <= 16 && at - 1 >= (i32)start)
        {
            acc |= (((u32)bytes[at] << 8) | (u32)bytes[at - 1]) << (16 - have);
            have += 16;
            at -= 2;
        }
        while (have <= 24)
        {
            u32 group = at >= (i32)start ? bytes[at] : 0;
            acc |= group << (24 - have);
            have += 8;
            at--;
        }
        code = packed[acc >> shift0];
        out[i] = (u8)(code & 0xff);
        acc <<= code >> 8;
        have -= code >> 8;
    }
    return 0;
}

/* --- a frame's state ---------------------------------------------------- */

typedef struct {
    Huffman huffman;
    FseTable ll, ml, of;
    int haveLl, haveMl, haveOf;
    u32 repeat1, repeat2, repeat3;
    u32 window;
} Frame;

static Frame frame;
static u8 literals[BLOCK_MAX + 64];

/* Decodes the literals section of a compressed block into `literals`,
 * answering their count through `count` and the section's end through `next`. */
static int decode_literals(const u8* bytes, u32 start, u32 limit, u32* count, u32* next){
    u32 first, type, format, header, regenerated, compressed = 0, streams = 1;
    u32 contentAt, contentEnd, treeSize = 0;
    int error;
    if (start >= limit) return ZSTD_E_TRUNCATED;
    first = bytes[start];
    type = first & 3;
    format = (first >> 2) & 3;
    if (type == 0 || type == 1)
    {
        if (format == 0 || format == 2)
        {
            header = 1;
            regenerated = first >> 3;
        }
        else if (format == 1)
        {
            if (start + 2 > limit) return ZSTD_E_TRUNCATED;
            header = 2;
            regenerated = (first >> 4) + ((u32)bytes[start + 1] << 4);
        }
        else
        {
            if (start + 3 > limit) return ZSTD_E_TRUNCATED;
            header = 3;
            regenerated = (first >> 4) + ((u32)bytes[start + 1] << 4) + ((u32)bytes[start + 2] << 12);
        }
        if (regenerated > BLOCK_MAX) return ZSTD_E_CORRUPT;
        if (type == 0)
        {
            if (start + header + regenerated > limit) return ZSTD_E_TRUNCATED;
            copy_forward(literals, bytes + start + header, regenerated);
            *count = regenerated;
            *next = start + header + regenerated;
            return 0;
        }
        if (start + header + 1 > limit) return ZSTD_E_TRUNCATED;
        {
            u8 value = bytes[start + header];
            u32 i;
            for (i = 0; i < regenerated; i++) literals[i] = value;
        }
        *count = regenerated;
        *next = start + header + 1;
        return 0;
    }
    if (format == 0 || format == 1)
    {
        if (start + 3 > limit) return ZSTD_E_TRUNCATED;
        header = 3;
        {
            u32 value = first + ((u32)bytes[start + 1] << 8) + ((u32)bytes[start + 2] << 16);
            regenerated = (value >> 4) & 0x3ff;
            compressed = (value >> 14) & 0x3ff;
        }
        streams = format == 0 ? 1 : 4;
    }
    else if (format == 2)
    {
        if (start + 4 > limit) return ZSTD_E_TRUNCATED;
        header = 4;
        {
            u32 value = read_u32(bytes + start);
            regenerated = (value >> 4) & 0x3fff;
            compressed = (value >> 18) & 0x3fff;
        }
        streams = 4;
    }
    else
    {
        if (start + 5 > limit) return ZSTD_E_TRUNCATED;
        header = 5;
        {
            u64 value = (u64)read_u32(bytes + start) | ((u64)bytes[start + 4] << 32);
            regenerated = (u32)((value >> 4) & 0x3ffff);
            compressed = (u32)((value >> 22) & 0x3ffff);
        }
        streams = 4;
    }
    if (regenerated > BLOCK_MAX) return ZSTD_E_CORRUPT;
    contentAt = start + header;
    contentEnd = contentAt + compressed;
    if (contentEnd > limit) return ZSTD_E_TRUNCATED;
    if (type == 2)
    {
        error = read_huffman_tree(bytes, contentAt, contentEnd, &frame.huffman, &treeSize);
        if (error) return error;
    }
    if (!frame.huffman.present) return ZSTD_E_CORRUPT;
    if (streams == 1)
    {
        error = decode_huffman_stream(bytes, contentAt + treeSize, contentEnd, &frame.huffman,
            literals, regenerated);
        if (error) return error;
    }
    else
    {
        u32 per = (regenerated + 3) >> 2;
        u32 streamsAt = contentAt + treeSize;
        u32 sizes[4], counts[4], at, i;
        i32 s4;
        if (streamsAt + 6 > contentEnd) return ZSTD_E_CORRUPT;
        sizes[0] = read_u16(bytes + streamsAt);
        sizes[1] = read_u16(bytes + streamsAt + 2);
        sizes[2] = read_u16(bytes + streamsAt + 4);
        s4 = (i32)(contentEnd - streamsAt) - 6 - (i32)sizes[0] - (i32)sizes[1] - (i32)sizes[2];
        if (s4 < 0) return ZSTD_E_CORRUPT;
        sizes[3] = (u32)s4;
        counts[0] = per;
        counts[1] = per;
        counts[2] = per;
        counts[3] = regenerated - 3 * per;
        if (3 * per > regenerated) counts[3] = 0;
        at = streamsAt + 6;
        for (i = 0; i < 4; i++)
        {
            if (at + sizes[i] > contentEnd) return ZSTD_E_CORRUPT;
            error = decode_huffman_stream(bytes, at, at + sizes[i], &frame.huffman,
                literals + i * per, counts[i]);
            if (error) return error;
            at += sizes[i];
        }
    }
    *count = regenerated;
    *next = contentEnd;
    return 0;
}

/* Reads one sequence table's mode: predefined, one symbol, compressed, or
 * the previous block's. `at` moves past what was read. */
static int choose_table(FseTable* table, int* have, u32 mode, const i32* predefinedProbs,
    u32 predefinedCount, u32 predefinedLog, u32 maxSymbol, u32 maxAccuracy,
    const u8* bytes, u32* at, u32 limit){
    if (mode == 0)
    {
        build_fse(table, predefinedProbs, predefinedCount, predefinedLog);
        *have = 1;
        return 0;
    }
    if (mode == 1)
    {
        if (*at >= limit) return ZSTD_E_TRUNCATED;
        table->rle = 1;
        table->rleSymbol = bytes[(*at)++];
        table->log = 0;
        *have = 1;
        return 0;
    }
    if (mode == 2)
    {
        Forward forward;
        Distribution dist;
        int error;
        forward.bytes = bytes;
        forward.size = limit;
        forward.bit = *at * 8;
        error = read_distribution(&forward, maxSymbol, maxAccuracy, &dist);
        if (error) return error;
        build_fse(table, dist.probs, dist.count, dist.log);
        *at += dist.bytes;
        *have = 1;
        return 0;
    }
    if (!*have) return ZSTD_E_CORRUPT;
    return 0;
}

/* The sequences of a compressed block, executed against the output. */
static int decode_compressed(const u8* bytes, u32 start, u32 end, u8* out, u32 outCapacity,
    u32* outLength, u32 frameStart){
    u32 litCount, at, sequences, modes, litAt = 0, sequence;
    u32 repeat1 = frame.repeat1, repeat2 = frame.repeat2, repeat3 = frame.repeat3;
    u32 llState = 0, ofState = 0, mlState = 0;
    Reverse stream;
    int error;
    error = decode_literals(bytes, start, end, &litCount, &at);
    if (error) return error;
    if (at >= end) return ZSTD_E_TRUNCATED;
    {
        u32 b0 = bytes[at++];
        if (b0 == 0) sequences = 0;
        else if (b0 < 128) sequences = b0;
        else if (b0 < 255)
        {
            if (at >= end) return ZSTD_E_TRUNCATED;
            sequences = ((b0 - 128) << 8) + bytes[at++];
        }
        else
        {
            if (at + 2 > end) return ZSTD_E_TRUNCATED;
            sequences = read_u16(bytes + at) + 0x7f00;
            at += 2;
        }
    }
    if (sequences == 0)
    {
        if (*outLength + litCount > outCapacity) return ZSTD_E_OUTPUT;
        copy_forward(out + *outLength, literals, litCount);
        *outLength += litCount;
        return 0;
    }
    if (at >= end) return ZSTD_E_TRUNCATED;
    modes = bytes[at++];
    error = choose_table(&frame.ll, &frame.haveLl, (modes >> 6) & 3, PREDEFINED_LL, 36, 6, 35, 9,
        bytes, &at, end);
    if (error) return error;
    error = choose_table(&frame.of, &frame.haveOf, (modes >> 4) & 3, PREDEFINED_OF, 29, 5, 31, 8,
        bytes, &at, end);
    if (error) return error;
    error = choose_table(&frame.ml, &frame.haveMl, (modes >> 2) & 3, PREDEFINED_ML, 53, 6, 52, 9,
        bytes, &at, end);
    if (error) return error;
    if (at > end) return ZSTD_E_TRUNCATED;
    error = reverse_init(&stream, bytes + at, end - at);
    if (error) return error;
    if (!frame.ll.rle) llState = reverse_read(&stream, frame.ll.log);
    if (!frame.of.rle) ofState = reverse_read(&stream, frame.of.log);
    if (!frame.ml.rle) mlState = reverse_read(&stream, frame.ml.log);
    for (sequence = 0; sequence < sequences; sequence++)
    {
        u32 offsetCode = frame.of.rle ? frame.of.rleSymbol : frame.of.symbol[ofState];
        u32 mlCode = frame.ml.rle ? frame.ml.rleSymbol : frame.ml.symbol[mlState];
        u32 llCode = frame.ll.rle ? frame.ll.rleSymbol : frame.ll.symbol[llState];
        u32 offsetValue, matchLength, literalLength, offset, produced;
        if (offsetCode > 31 || mlCode > 52 || llCode > 35) return ZSTD_E_CORRUPT;
        offsetValue = offsetCode == 0 ? 1 : (1u << offsetCode) + reverse_read(&stream, offsetCode);
        matchLength = ML_BASE[mlCode] + reverse_read(&stream, ML_BITS[mlCode]);
        literalLength = LL_BASE[llCode] + reverse_read(&stream, LL_BITS[llCode]);
        if (offsetValue > 3)
        {
            offset = offsetValue - 3;
            repeat3 = repeat2;
            repeat2 = repeat1;
            repeat1 = offset;
        }
        else
        {
            u32 effective = literalLength == 0 ? offsetValue + 1 : offsetValue;
            if (effective == 1)
            {
                offset = repeat1;
            }
            else if (effective == 2)
            {
                offset = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
            else if (effective == 3)
            {
                offset = repeat3;
                repeat3 = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
            else
            {
                offset = repeat1 - 1;
                repeat3 = repeat2;
                repeat2 = repeat1;
                repeat1 = offset;
            }
        }
        produced = *outLength - frameStart;
        if (litAt + literalLength > litCount) return ZSTD_E_CORRUPT;
        if (offset == 0 || offset > frame.window || offset > produced + literalLength)
        {
            return ZSTD_E_CORRUPT;
        }
        if (*outLength + literalLength + matchLength > outCapacity) return ZSTD_E_OUTPUT;
        if (literalLength > 0)
        {
            copy_forward(out + *outLength, literals + litAt, literalLength);
            *outLength += literalLength;
            litAt += literalLength;
        }
        copy_forward(out + *outLength, out + *outLength - offset, matchLength);
        *outLength += matchLength;
        if (sequence + 1 < sequences)
        {
            if (!frame.ll.rle)
                llState = (u32)(frame.ll.baseline[llState] + (i32)reverse_read(&stream, frame.ll.numBits[llState]));
            if (!frame.ml.rle)
                mlState = (u32)(frame.ml.baseline[mlState] + (i32)reverse_read(&stream, frame.ml.numBits[mlState]));
            if (!frame.of.rle)
                ofState = (u32)(frame.of.baseline[ofState] + (i32)reverse_read(&stream, frame.of.numBits[ofState]));
        }
    }
    if (litAt < litCount)
    {
        if (*outLength + (litCount - litAt) > outCapacity) return ZSTD_E_OUTPUT;
        copy_forward(out + *outLength, literals + litAt, litCount - litAt);
        *outLength += litCount - litAt;
    }
    frame.repeat1 = repeat1;
    frame.repeat2 = repeat2;
    frame.repeat3 = repeat3;
    return 0;
}

/* One frame from its magic; `at` moves past it. */
static int decode_frame(const u8* in, u32 inLength, u32* at, u8* out, u32 outCapacity, u32* outLength){
    u32 p = *at + 4, descriptor, fcs, single, checksum, dict, window = 0, dictId = 0;
    u64 contentSize = 0;
    u32 frameStart = *outLength;
    int error;
    if (p + 1 > inLength) return ZSTD_E_TRUNCATED;
    descriptor = in[p++];
    fcs = descriptor >> 6;
    single = (descriptor >> 5) & 1;
    checksum = (descriptor >> 2) & 1;
    dict = descriptor & 3;
    if (!single)
    {
        u32 wd, base;
        if (p >= inLength) return ZSTD_E_TRUNCATED;
        wd = in[p++];
        if ((wd >> 3) + 10 > 31) return ZSTD_E_UNSUPPORTED;
        base = 1u << (10 + (wd >> 3));
        window = base + (base >> 3) * (wd & 7);
        if (window > MAX_WINDOW) return ZSTD_E_UNSUPPORTED;
    }
    if (dict == 1)
    {
        if (p >= inLength) return ZSTD_E_TRUNCATED;
        dictId = in[p++];
    }
    else if (dict == 2)
    {
        if (p + 2 > inLength) return ZSTD_E_TRUNCATED;
        dictId = read_u16(in + p);
        p += 2;
    }
    else if (dict == 3)
    {
        if (p + 4 > inLength) return ZSTD_E_TRUNCATED;
        dictId = read_u32(in + p);
        p += 4;
    }
    if (dictId != 0) return ZSTD_E_UNSUPPORTED;
    if (fcs == 0)
    {
        if (single)
        {
            if (p >= inLength) return ZSTD_E_TRUNCATED;
            contentSize = in[p++];
        }
    }
    else if (fcs == 1)
    {
        if (p + 2 > inLength) return ZSTD_E_TRUNCATED;
        contentSize = (u64)read_u16(in + p) + 256;
        p += 2;
    }
    else if (fcs == 2)
    {
        if (p + 4 > inLength) return ZSTD_E_TRUNCATED;
        contentSize = read_u32(in + p);
        p += 4;
    }
    else
    {
        if (p + 8 > inLength) return ZSTD_E_TRUNCATED;
        contentSize = (u64)read_u32(in + p) | ((u64)read_u32(in + p + 4) << 32);
        p += 8;
    }
    if (single)
    {
        window = contentSize > MAX_WINDOW ? MAX_WINDOW : (u32)contentSize;
    }
    frame.huffman.present = 0;
    frame.haveLl = frame.haveMl = frame.haveOf = 0;
    frame.ll.rle = frame.ml.rle = frame.of.rle = 0;
    frame.repeat1 = 1;
    frame.repeat2 = 4;
    frame.repeat3 = 8;
    frame.window = window > 0 ? window : MAX_WINDOW;
    for (;;)
    {
        u32 block, last, type, size;
        if (p + 3 > inLength) return ZSTD_E_TRUNCATED;
        block = read_u24(in + p);
        p += 3;
        last = block & 1;
        type = (block >> 1) & 3;
        size = block >> 3;
        if (type == 3) return ZSTD_E_UNSUPPORTED;
        if (p + (type == 1 ? 1 : size) > inLength) return ZSTD_E_TRUNCATED;
        if (type == 0)
        {
            if (*outLength + size > outCapacity) return ZSTD_E_OUTPUT;
            copy_forward(out + *outLength, in + p, size);
            *outLength += size;
            p += size;
        }
        else if (type == 1)
        {
            u8 value = in[p];
            u32 i;
            if (*outLength + size > outCapacity) return ZSTD_E_OUTPUT;
            for (i = 0; i < size; i++) out[*outLength + i] = value;
            *outLength += size;
            p += 1;
        }
        else
        {
            u32 blockEnd = p + size;
            error = decode_compressed(in, p, blockEnd, out, outCapacity, outLength, frameStart);
            if (error) return error;
            p = blockEnd;
        }
        if (last) break;
    }
    if (checksum)
    {
        if (p + 4 > inLength) return ZSTD_E_TRUNCATED;
        p += 4;
    }
    *at = p;
    return 0;
}

EXPORT(zstd_version)
u32 zstd_version(void){
    return 1;
}

EXPORT(zstd_decompress)
i32 zstd_decompress(const u8* in, u32 inLength, u8* out, u32 outCapacity){
    u32 at = 0, outLength = 0;
    while (at < inLength)
    {
        u32 magic;
        int error;
        if (at + 4 > inLength) return ZSTD_E_TRUNCATED;
        magic = read_u32(in + at);
        if ((magic & SKIPPABLE_MASK) == SKIPPABLE)
        {
            if (at + 8 > inLength) return ZSTD_E_TRUNCATED;
            at += 8 + read_u32(in + at + 4);
            if (at > inLength) return ZSTD_E_TRUNCATED;
            continue;
        }
        if (magic != MAGIC) return ZSTD_E_CORRUPT;
        error = decode_frame(in, inLength, &at, out, outCapacity, &outLength);
        if (error) return error;
    }
    return (i32)outLength;
}
