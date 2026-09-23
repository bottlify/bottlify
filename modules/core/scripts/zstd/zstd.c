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
 *
 * `out` must have OUT_SLACK (32) bytes of room past `outCapacity`: a copy
 * runs eight or sixteen bytes at a time and writes past its own end by up
 * to that, the way the reference decoder's wild copies do, so a short
 * literal run or match costs two moves rather than a byte loop. Nothing
 * past `outCapacity` is ever counted as output.
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
#define OUT_SLACK 32u
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

/* Unaligned 64-bit loads and stores: an eight-byte memcpy of constant size,
 * which every compiler lowers to a single load or store (wasm allows
 * unaligned access), is what makes a copy a word at a time rather than a
 * byte. The wasm build names the builtin so no call to the memcpy below is
 * ever emitted; a native build takes its libc's. */
#ifdef __wasm__
#define COPY8(dst, src) __builtin_memcpy((dst), (src), 8)
#define COPY4(dst, src) __builtin_memcpy((dst), (src), 4)
#else
#include <string.h>
#define COPY8(dst, src) memcpy((dst), (src), 8)
#define COPY4(dst, src) memcpy((dst), (src), 4)
#endif

static u64 load64(const u8* at){
    u64 value;
    COPY8(&value, at);
    return value;
}

static void store64(u8* at, u64 value){
    COPY8(at, &value);
}

/* A copy whose source and destination do not overlap within eight bytes:
 * literals, raw blocks and matches whose offset is at least eight. Eight
 * bytes at a time, the tail by bytes. */
static void copy_wide(u8* dst, const u8* src, u32 n){
    while (n >= 8)
    {
        store64(dst, load64(src));
        dst += 8;
        src += 8;
        n -= 8;
    }
    while (n--) *dst++ = *src++;
}

static void copy_forward(u8* dst, const u8* src, u32 n){
    copy_wide(dst, src, n);
}

/* At least n bytes, eight at a time, the last store past n by up to seven:
 * for a place with OUT_SLACK bytes of room beyond the copy's end. */
static void copy_over(u8* dst, const u8* src, u32 n){
    u8* end = dst + n;
    do
    {
        store64(dst, load64(src));
        dst += 8;
        src += 8;
    }
    while (dst < end);
}

/* Sixteen bytes for a copy of at most sixteen: a short literal run is two
 * moves whatever its length, the rest overwritten by what follows. */
static void copy16(u8* dst, const u8* src){
    store64(dst, load64(src));
    store64(dst + 8, load64(src + 8));
}

/* A match at a place with OUT_SLACK bytes of room beyond its end, the
 * reference decoder's way: an offset below eight is widened by writing the
 * first eight bytes through its pattern, after which the source stands a
 * multiple of the pattern's period and at least eight behind, and the rest
 * goes eight at a time. */
static void copy_match_over(u8* dst, u32 offset, u32 n){
    static const u32 STEP[8] = { 0, 1, 2, 1, 4, 4, 4, 4 };
    static const i32 BACK[8] = { 8, 8, 8, 7, 8, 9, 10, 11 };
    const u8* src = dst - offset;
    u8* end = dst + n;
    if (offset < 8)
    {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
        dst[3] = src[3];
        src += STEP[offset];
        COPY4(dst + 4, src);
        src -= BACK[offset];
        dst += 8;
        src += 8;
        if (dst >= end) return;
        n = (u32)(end - dst);
    }
    copy_over(dst, src, n);
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

/* Backward, from the marker bit at the end: the weights and the sequences.
 * The next bits sit at the top of a 64-bit container refilled a byte at a
 * time from the end of the stream towards its start; bytes before the start
 * read as zero, as the reference reader has them. `bit` is the number of bits
 * left below the marker, which the weights loop reads. */
typedef struct {
    const u8* bytes;
    i32 at;       /* the next byte to pull into the container, going down */
    u64 acc;
    u32 have;     /* bits in the container */
    i32 bit;
} Reverse;

static void reverse_refill(Reverse* r){
    while (r->have <= 56)
    {
        u64 byte = r->at >= 0 ? r->bytes[r->at] : 0;
        r->acc |= byte << (56 - r->have);
        r->have += 8;
        r->at--;
    }
}

static int reverse_init(Reverse* r, const u8* bytes, u32 size){
    r->bytes = bytes;
    r->acc = 0;
    r->have = 0;
    r->bit = 0;
    r->at = -1;
    if (size > 0)
    {
        u8 last = bytes[size - 1];
        u32 stop;
        if (last == 0) return ZSTD_E_CORRUPT;
        stop = high_bit(last);
        r->acc = stop == 0 ? 0 : ((u64)(last & ((1u << stop) - 1))) << (64 - stop);
        r->have = stop;
        r->at = (i32)size - 2;
        r->bit = (i32)(size - 1) * 8 + (i32)stop;
    }
    reverse_refill(r);
    return 0;
}

/* The next n bits, n at most 32, the first read bit the highest. */
static u32 reverse_read(Reverse* r, u32 n){
    u32 value;
    if (n == 0) return 0;
    if (r->have < n) reverse_refill(r);
    value = (u32)(r->acc >> (64 - n));
    r->acc <<= n;
    r->have -= n;
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

/* A Huffman stream's reader, in the reference decoder's shape: a 64-bit window
 * of the stream's bytes with the newest at the top and a count of the bits
 * already taken from it. A symbol is looked up on the next maxBits bits and
 * its width added to the count; after four symbols the window moves down by
 * the whole bytes consumed with one load. Bytes before the stream's start
 * read as zero, the window then assembled a byte at a time. */
typedef struct {
    u64 window;
    u32 consumed;   /* bits of the window already taken, from the top */
    i32 at;         /* the index of the window's low byte, or below the start */
    i32 start;
} HufBits;

static void huf_window(const u8* bytes, HufBits* s){
    if (s->at >= s->start)
    {
        s->window = load64(bytes + s->at);
        return;
    }
    {
        u32 i;
        s->window = 0;
        for (i = 0; i < 8; i++)
        {
            i32 idx = s->at + (i32)i;
            u64 byte = idx >= s->start ? bytes[idx] : 0;
            s->window |= byte << (8 * i);
        }
    }
}

static int huf_init(HufBits* s, const u8* bytes, u32 start, u32 end){
    u32 last, stop;
    if (end <= start) return ZSTD_E_CORRUPT;
    last = bytes[end - 1];
    if (last == 0) return ZSTD_E_CORRUPT;
    stop = high_bit(last);
    s->start = (i32)start;
    s->at = (i32)end - 8;
    huf_window(bytes, s);
    /* The marker bit and what is above it are not the stream's. */
    s->consumed = 8 - stop;
    return 0;
}

/* Moves the window down by the bytes consumed: one load when they are there.
 * Called after at most four symbols, so the count is below 56 and a peek
 * before it has at least twenty-one bits, more than a symbol's width. */
static void huf_reload(const u8* bytes, HufBits* s){
    u32 whole = s->consumed >> 3;
    if (whole == 0) return;
    s->at -= (i32)whole;
    s->consumed &= 7;
    huf_window(bytes, s);
}

#define HUF_PEEK(s, shift0) ((u32)(((s).window << (s).consumed) >> (shift0)))
/* The next n bits of the window into dst, n up to 32 and possibly zero: the
 * two shifts keep a shift by the word's width out of the expression. */
#define BITS_TAKE(s, n, dst) do { \
    u32 n_ = (n); \
    (dst) = (u32)((((s).window << (s).consumed) >> 1) >> (63 - n_)); \
    (s).consumed += n_; \
} while (0)
#define HUF_SYMBOL(s, packed, shift0, dst) do { \
    u16 code_ = (packed)[HUF_PEEK(s, shift0)]; \
    (dst) = (u8)(code_ & 0xff); \
    (s).consumed += code_ >> 8; \
} while (0)

/* One Huffman-coded stream, read backward from `end`, `count` symbols into `out`. */
static int decode_huffman_stream(const u8* bytes, u32 start, u32 end, const Huffman* h, u8* out, u32 count){
    HufBits s;
    const u16* packed = h->packed;
    u32 shift0 = 64 - h->maxBits;
    u32 i = 0;
    int error;
    if (count == 0) return 0;
    error = huf_init(&s, bytes, start, end);
    if (error) return error;
    while (i + 4 <= count)
    {
        HUF_SYMBOL(s, packed, shift0, out[i]);
        HUF_SYMBOL(s, packed, shift0, out[i + 1]);
        HUF_SYMBOL(s, packed, shift0, out[i + 2]);
        HUF_SYMBOL(s, packed, shift0, out[i + 3]);
        huf_reload(bytes, &s);
        i += 4;
    }
    while (i < count)
    {
        HUF_SYMBOL(s, packed, shift0, out[i]);
        huf_reload(bytes, &s);
        i++;
    }
    return 0;
}

/* The four streams of a literals section decoded in lockstep, so the four
 * dependency chains overlap in the processor instead of running one after
 * another. Streams one to three carry `per` symbols, the fourth `rest`. */
static int decode_huffman_4(const u8* bytes, const u32* starts, const u32* ends, const Huffman* h,
    u8* out, u32 per, u32 rest){
    HufBits s0, s1, s2, s3;
    const u16* packed = h->packed;
    u32 shift0 = 64 - h->maxBits;
    u32 i = 0;
    int error;
    u8* o0 = out;
    u8* o1 = out + per;
    u8* o2 = out + 2 * per;
    u8* o3 = out + 3 * per;
    error = huf_init(&s0, bytes, starts[0], ends[0]);
    if (error) return error;
    error = huf_init(&s1, bytes, starts[1], ends[1]);
    if (error) return error;
    error = huf_init(&s2, bytes, starts[2], ends[2]);
    if (error) return error;
    if (rest > 0)
    {
        error = huf_init(&s3, bytes, starts[3], ends[3]);
        if (error) return error;
    }
    /* Four symbols per stream per reload, the streams interleaved. */
    while (i + 4 <= rest)
    {
        u32 k;
        for (k = 0; k < 4; k++)
        {
            HUF_SYMBOL(s0, packed, shift0, o0[i + k]);
            HUF_SYMBOL(s1, packed, shift0, o1[i + k]);
            HUF_SYMBOL(s2, packed, shift0, o2[i + k]);
            HUF_SYMBOL(s3, packed, shift0, o3[i + k]);
        }
        huf_reload(bytes, &s0);
        huf_reload(bytes, &s1);
        huf_reload(bytes, &s2);
        huf_reload(bytes, &s3);
        i += 4;
    }
    for (; i < per; i++)
    {
        HUF_SYMBOL(s0, packed, shift0, o0[i]);
        HUF_SYMBOL(s1, packed, shift0, o1[i]);
        HUF_SYMBOL(s2, packed, shift0, o2[i]);
        huf_reload(bytes, &s0);
        huf_reload(bytes, &s1);
        huf_reload(bytes, &s2);
        if (i < rest)
        {
            HUF_SYMBOL(s3, packed, shift0, o3[i]);
            huf_reload(bytes, &s3);
        }
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
        {
            u32 starts[4], ends[4];
            for (i = 0; i < 4; i++)
            {
                if (at + sizes[i] > contentEnd) return ZSTD_E_CORRUPT;
                starts[i] = at;
                ends[i] = at + sizes[i];
                at += sizes[i];
            }
            error = decode_huffman_4(bytes, starts, ends, &frame.huffman, literals, per, counts[3]);
            if (error) return error;
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
        /* One symbol: a table of one cell with no bits, so the sequence loop
         * reads it like any other -- a state of zero, zero bits per step. */
        if (*at >= limit) return ZSTD_E_TRUNCATED;
        table->rle = 0;
        table->rleSymbol = 0;
        table->log = 0;
        table->symbol[0] = bytes[(*at)++];
        table->numBits[0] = 0;
        table->baseline[0] = 0;
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
    u32 llState, ofState, mlState, extra;
    HufBits s;
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
    if (at >= end) return ZSTD_E_TRUNCATED;
    /* The reference decoder's shape: a 64-bit window reloaded once or twice
     * a sequence, never inside a read. A reload leaves at least 57 bits, so
     * the offset's (up to 31) and the match length's (up to 16) fit after
     * one, the literal length's (16) and the three states' (up to 27)
     * after the next. */
    error = huf_init(&s, bytes, at, end);
    if (error) return error;
    BITS_TAKE(s, frame.ll.log, llState);
    BITS_TAKE(s, frame.of.log, ofState);
    BITS_TAKE(s, frame.ml.log, mlState);
    huf_reload(bytes, &s);
    for (sequence = 0; sequence < sequences; sequence++)
    {
        u32 offsetCode = frame.of.symbol[ofState];
        u32 mlCode = frame.ml.symbol[mlState];
        u32 llCode = frame.ll.symbol[llState];
        u32 offsetValue, matchLength, literalLength, offset, produced;
        if (offsetCode > 31 || mlCode > 52 || llCode > 35) return ZSTD_E_CORRUPT;
        BITS_TAKE(s, offsetCode, extra);
        offsetValue = offsetCode == 0 ? 1 : (1u << offsetCode) + extra;
        BITS_TAKE(s, ML_BITS[mlCode], extra);
        matchLength = ML_BASE[mlCode] + extra;
        huf_reload(bytes, &s);
        BITS_TAKE(s, LL_BITS[llCode], extra);
        literalLength = LL_BASE[llCode] + extra;
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
        /* Both copies may run past their end into OUT_SLACK or into what the
         * next copy overwrites; the literals buffer has its own slack. */
        if (literalLength <= 16)
        {
            copy16(out + *outLength, literals + litAt);
        }
        else
        {
            copy_over(out + *outLength, literals + litAt, literalLength);
        }
        *outLength += literalLength;
        litAt += literalLength;
        copy_match_over(out + *outLength, offset, matchLength);
        *outLength += matchLength;
        if (sequence + 1 < sequences)
        {
            BITS_TAKE(s, frame.ll.numBits[llState], extra);
            llState = (u32)(frame.ll.baseline[llState] + (i32)extra);
            BITS_TAKE(s, frame.ml.numBits[mlState], extra);
            mlState = (u32)(frame.ml.baseline[mlState] + (i32)extra);
            BITS_TAKE(s, frame.of.numBits[ofState], extra);
            ofState = (u32)(frame.of.baseline[ofState] + (i32)extra);
            huf_reload(bytes, &s);
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
