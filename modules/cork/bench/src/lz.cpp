/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * What an archive reader does while a level loads: LZ77 with hash chains
 * compressing text-like data and decompressing it again, a table CRC over
 * the result, and a Huffman code built from byte counts, packed bit by bit
 * and decoded through a lookup table.
 */

#include "rt.h"

namespace {

const u32 SIZE = 1 << 16;
const u32 WINDOW = 4096;
const u32 HASH = 1 << 12;
const u32 MAX_MATCH = 66;

static u32 crcTable[256];

static void makeCrc()
{
    for (u32 n = 0; n < 256; n++)
    {
        u32 c = n;
        for (int k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        }
        crcTable[n] = c;
    }
}

static u32 crc(const u8 *data, u32 length)
{
    u32 c = 0xffffffffu;
    for (u32 i = 0; i < length; i++)
    {
        c = crcTable[(c ^ data[i]) & 0xff] ^ (c >> 8);
    }
    return c ^ 0xffffffffu;
}

static inline u32 hash3(const u8 *p)
{
    return ((u32)p[0] << 8 ^ (u32)p[1] << 4 ^ p[2]) & (HASH - 1);
}

/* Tokens: a literal is 0x00 byte; a match is 0x80|(len-3) then two bytes of distance. */
static u32 compress(const u8 *in, u32 length, u8 *out, i32 *head, i32 *chain)
{
    for (u32 i = 0; i < HASH; i++)
    {
        head[i] = -1;
    }
    u32 o = 0, i = 0;
    while (i < length)
    {
        u32 bestLen = 0, bestDist = 0;
        if (i + 3 <= length)
        {
            u32 h = hash3(in + i);
            i32 candidate = head[h];
            u32 tries = 16;
            while (candidate >= 0 && i - (u32)candidate <= WINDOW && tries--)
            {
                u32 len = 0;
                u32 limit = length - i < MAX_MATCH ? length - i : MAX_MATCH;
                while (len < limit && in[(u32)candidate + len] == in[i + len])
                {
                    len++;
                }
                if (len > bestLen)
                {
                    bestLen = len;
                    bestDist = i - (u32)candidate;
                }
                candidate = chain[(u32)candidate & (WINDOW - 1)];
            }
            chain[i & (WINDOW - 1)] = head[h];
            head[h] = (i32)i;
        }
        if (bestLen >= 3)
        {
            out[o++] = (u8)(0x80 | (bestLen - 3));
            out[o++] = (u8)bestDist;
            out[o++] = (u8)(bestDist >> 8);
            for (u32 k = 1; k < bestLen; k++)
            {
                if (i + k + 3 <= length)
                {
                    u32 h = hash3(in + i + k);
                    chain[(i + k) & (WINDOW - 1)] = head[h];
                    head[h] = (i32)(i + k);
                }
            }
            i += bestLen;
        }
        else
        {
            out[o++] = 0;
            out[o++] = in[i++];
        }
    }
    return o;
}

static u32 decompress(const u8 *in, u32 length, u8 *out)
{
    u32 o = 0, i = 0;
    while (i < length)
    {
        u8 token = in[i++];
        if (token & 0x80)
        {
            u32 len = (token & 0x7f) + 3;
            u32 dist = in[i] | (u32)in[i + 1] << 8;
            i += 2;
            const u8 *from = out + o - dist;
            for (u32 k = 0; k < len; k++)
            {
                out[o + k] = from[k];
            }
            o += len;
        }
        else
        {
            out[o++] = in[i++];
        }
    }
    return o;
}

struct Symbol {
    u32 count;
    u32 symbol;
};

/* Code lengths by repeatedly merging the two lightest -- package by weight, capped at 15. */
static void codeLengths(const u32 *counts, u8 *lengths)
{
    static Symbol items[512];
    static u32 parentOf[512];
    u32 n = 0;
    for (u32 s = 0; s < 256; s++)
    {
        lengths[s] = 0;
        if (counts[s])
        {
            items[n++] = { counts[s], s };
        }
    }
    if (n == 1)
    {
        lengths[items[0].symbol] = 1;
        return;
    }
    // Selection by linear scan: small alphabet, and the scans are the point.
    static u32 live[512];
    u32 alive = n;
    for (u32 i = 0; i < n; i++)
    {
        live[i] = i;
        parentOf[i] = 0;
    }
    u32 next = n;
    while (alive > 1)
    {
        u32 a = 0, b = 1;
        if (items[live[b]].count < items[live[a]].count)
        {
            a = 1;
            b = 0;
        }
        for (u32 i = 2; i < alive; i++)
        {
            u32 c = items[live[i]].count;
            if (c < items[live[a]].count)
            {
                b = a;
                a = i;
            }
            else if (c < items[live[b]].count)
            {
                b = i;
            }
        }
        items[next] = { items[live[a]].count + items[live[b]].count, 0 };
        parentOf[live[a]] = next;
        parentOf[live[b]] = next;
        parentOf[next] = 0;
        u32 hi = a > b ? a : b, lo = a > b ? b : a;
        live[hi] = live[--alive];
        live[lo] = next++;
    }
    u32 root = next - 1;
    for (u32 i = 0; i < n; i++)
    {
        u32 depth = 0;
        for (u32 at = i; at != root; at = parentOf[at])
        {
            depth++;
        }
        lengths[items[i].symbol] = (u8)(depth > 15 ? 15 : depth);
    }
}

} // namespace

u32 workLz(u32 iterations)
{
    static const char *const WORDS[] = { "the ", "unit ", "attack ", "tower ", "stone ", "mine ",
        "wood ", "tree ", "hero ", "level ", "north ", "south ", "river ", "bridge ", "gate ", "spell ",
        "power ", "armor ", "damage ", "move ", "\r\n", "trigger ", "event ", "region ", "player " };
    Rng rng(0x5eed0005u);
    makeCrc();
    u8 *text = take<u8>(SIZE);
    u8 *packed = take<u8>(SIZE * 2 + 16);
    u8 *unpacked = take<u8>(SIZE + MAX_MATCH);
    i32 *head = take<i32>(HASH);
    i32 *chain = take<i32>(WINDOW);
    u32 *bits = take<u32>(SIZE / 2);
    u32 filled = 0;
    while (filled < SIZE)
    {
        const char *w = WORDS[rng.below(sizeof WORDS / sizeof *WORDS)];
        if (rng.below(8) == 0)
        {
            text[filled++] = (u8)('0' + rng.below(10));
            continue;
        }
        while (*w && filled < SIZE)
        {
            text[filled++] = (u8)*w++;
        }
    }
    u32 sum = 0;
    for (u32 it = 0; it < iterations; it++)
    {
        // A different stretch each time, so the chains are not the same walk.
        text[(it * 7919) % SIZE] = (u8)('a' + it % 26);
        u32 size = compress(text, SIZE, packed, head, chain);
        u32 back = decompress(packed, size, unpacked);
        u32 ok = back == SIZE;
        for (u32 i = 0; ok && i < SIZE; i++)
        {
            ok = unpacked[i] == text[i];
        }
        sum = mix(sum, size);
        sum = mix(sum, crc(unpacked, back) ^ ok);

        u32 counts[256] = {};
        for (u32 i = 0; i < SIZE; i++)
        {
            counts[text[i]]++;
        }
        u8 lengths[256];
        codeLengths(counts, lengths);
        // Canonical codes, then encode a quarter of the text and decode it back.
        u32 codes[256];
        u32 code = 0;
        for (u32 len = 1; len <= 15; len++)
        {
            for (u32 s = 0; s < 256; s++)
            {
                if (lengths[s] == len)
                {
                    codes[s] = code++;
                }
            }
            code <<= 1;
        }
        memset(bits, 0, SIZE / 2 * sizeof(u32));
        u32 bitPos = 0;
        const u32 part = SIZE / 4;
        for (u32 i = 0; i < part; i++)
        {
            u32 s = text[i];
            for (i32 b = lengths[s] - 1; b >= 0; b--)
            {
                if (codes[s] >> b & 1)
                {
                    bits[bitPos >> 5] |= 1u << (bitPos & 31);
                }
                bitPos++;
            }
        }
        u32 at = 0, decoded = 0, mismatch = 0;
        for (u32 i = 0; i < part; i++)
        {
            u32 value = 0;
            u32 len = 0;
            u32 found = 256;
            while (found == 256 && len < 15)
            {
                value = value << 1 | (bits[at >> 5] >> (at & 31) & 1);
                at++;
                len++;
                for (u32 s = 0; s < 256; s++)
                {
                    if (lengths[s] == len && codes[s] == value)
                    {
                        found = s;
                        break;
                    }
                }
            }
            decoded++;
            mismatch += found != text[i];
        }
        sum = mix(sum, bitPos ^ decoded << 8 ^ mismatch);
    }
    return sum;
}
