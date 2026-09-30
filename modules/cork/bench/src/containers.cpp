/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The data structures an engine keeps its state in: a hash table with string
 * keys, sorts instantiated for several element types and orders (so each is
 * its own code), binary search, and an LRU cache as a list threaded through
 * a table.
 */

#include "rt.h"

namespace {

static u32 length(const char *s)
{
    u32 n = 0;
    while (s[n])
    {
        n++;
    }
    return n;
}

static int compare(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return (int)(u8)*a - (int)(u8)*b;
}

static u32 hashString(const char *s)
{
    u32 h = 2166136261u;
    while (*s)
    {
        h = (h ^ (u8)*s++) * 16777619u;
    }
    return h;
}

struct Table {
    const char **keys;
    u32 *values;
    u8 *state; // 0 empty, 1 full, 2 deleted
    u32 capacity;
    u32 probes;

    u32 slot(const char *key, bool forInsert)
    {
        u32 mask = capacity - 1;
        u32 i = hashString(key) & mask;
        u32 tomb = ~0u;
        for (;;)
        {
            probes++;
            if (state[i] == 0)
            {
                return forInsert && tomb != ~0u ? tomb : i;
            }
            if (state[i] == 2)
            {
                if (tomb == ~0u)
                {
                    tomb = i;
                }
            }
            else if (compare(keys[i], key) == 0)
            {
                return i;
            }
            i = (i + 1) & mask;
        }
    }

    void put(const char *key, u32 value)
    {
        u32 i = slot(key, true);
        keys[i] = key;
        values[i] = value;
        state[i] = 1;
    }

    bool get(const char *key, u32 *value)
    {
        u32 i = slot(key, false);
        if (state[i] != 1)
        {
            return false;
        }
        *value = values[i];
        return true;
    }

    bool erase(const char *key)
    {
        u32 i = slot(key, false);
        if (state[i] != 1)
        {
            return false;
        }
        state[i] = 2;
        return true;
    }
};

template <typename T, typename Less> static void insertionSort(T *a, i32 n, Less less)
{
    for (i32 i = 1; i < n; i++)
    {
        T v = a[i];
        i32 j = i - 1;
        while (j >= 0 && less(v, a[j]))
        {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = v;
    }
}

template <typename T, typename Less> static void quickSort(T *a, i32 n, Less less)
{
    while (n > 16)
    {
        T x = a[0], y = a[n / 2], z = a[n - 1];
        T pivot = less(x, y) ? (less(y, z) ? y : less(x, z) ? z : x) : (less(x, z) ? x : less(y, z) ? z : y);
        i32 i = 0, j = n - 1;
        for (;;)
        {
            while (less(a[i], pivot))
            {
                i++;
            }
            while (less(pivot, a[j]))
            {
                j--;
            }
            if (i >= j)
            {
                break;
            }
            T t = a[i];
            a[i] = a[j];
            a[j] = t;
            i++;
            j--;
        }
        // Recurse into the smaller side, loop on the larger.
        if (j + 1 < n - j - 1)
        {
            quickSort(a, j + 1, less);
            a += j + 1;
            n -= j + 1;
        }
        else
        {
            quickSort(a + j + 1, n - j - 1, less);
            n = j + 1;
        }
    }
    insertionSort(a, n, less);
}

template <typename T, typename Less> static void mergeSort(T *a, T *scratch, u32 n, Less less)
{
    for (u32 width = 1; width < n; width *= 2)
    {
        for (u32 lo = 0; lo < n; lo += 2 * width)
        {
            u32 mid = lo + width < n ? lo + width : n;
            u32 hi = lo + 2 * width < n ? lo + 2 * width : n;
            u32 i = lo, j = mid, k = lo;
            while (i < mid && j < hi)
            {
                scratch[k++] = less(a[j], a[i]) ? a[j++] : a[i++];
            }
            while (i < mid)
            {
                scratch[k++] = a[i++];
            }
            while (j < hi)
            {
                scratch[k++] = a[j++];
            }
        }
        memcpy(a, scratch, n * sizeof(T));
    }
}

struct Record {
    u32 key;
    u16 group;
    u16 rank;
    float score;
};

struct Node {
    u32 key, value, prev, next;
};

} // namespace

u32 workContainers(u32 iterations)
{
    Rng rng(0x5eed0006u);
    const u32 WORDS = 8192;
    const u32 N = 16384;
    char *text = take<char>(WORDS * 12);
    const char **words = take<const char *>(WORDS);
    for (u32 w = 0; w < WORDS; w++)
    {
        char *at = text + w * 12;
        u32 len = 3 + rng.below(8);
        for (u32 k = 0; k < len; k++)
        {
            at[k] = (char)('a' + rng.below(26));
        }
        at[len] = 0;
        words[w] = at;
    }
    Table table{ take<const char *>(1 << 14), take<u32>(1 << 14), take<u8>(1 << 14), 1 << 14, 0 };
    u32 *ints = take<u32>(N);
    u32 *intScratch = take<u32>(N);
    Record *records = take<Record>(N);
    Record *recordScratch = take<Record>(N);
    const char **sorted = take<const char *>(WORDS);
    const u32 LRU = 1024;
    Node *nodes = take<Node>(LRU + 1);
    u32 *where = take<u32>(4096);

    u32 sum = 0;
    for (u32 it = 0; it < iterations; it++)
    {
        // Hash table: fill, look up present and absent, erase some, look up again.
        memset(table.state, 0, table.capacity);
        for (u32 w = 0; w < WORDS; w++)
        {
            table.put(words[w], w * 3 + it);
        }
        u32 found = 0, value = 0;
        for (u32 k = 0; k < WORDS * 2; k++)
        {
            const char *key = words[rng.below(WORDS)];
            if (table.get(key, &value))
            {
                found += value & 7;
            }
        }
        for (u32 w = it & 1; w < WORDS; w += 3)
        {
            table.erase(words[w]);
        }
        for (u32 w = 0; w < WORDS; w++)
        {
            found += table.get(words[w], &value);
        }
        sum = mix(sum, found ^ table.probes);

        // Sorts over several element types and orders.
        for (u32 i = 0; i < N; i++)
        {
            ints[i] = rng.next() >> (it & 7);
            records[i] = { rng.next(), (u16)rng.below(64), (u16)rng.below(1000), rng.unit() };
        }
        quickSort(ints, (i32)N, [](u32 a, u32 b) { return a < b; });
        sum = mix(sum, ints[0] ^ ints[N / 2] ^ ints[N - 1]);
        quickSort(ints, (i32)N, [](u32 a, u32 b) { return (a ^ 0x5555u) % 1009 < (b ^ 0x5555u) % 1009; });
        mergeSort(ints, intScratch, N, [](u32 a, u32 b) { return (a & 0xff) < (b & 0xff); });
        sum = mix(sum, ints[1] ^ ints[N - 2]);
        quickSort(records, (i32)N, [](const Record &a, const Record &b) {
            return a.group != b.group ? a.group < b.group : a.score > b.score;
        });
        mergeSort(records, recordScratch, N, [](const Record &a, const Record &b) { return a.rank < b.rank; });
        sum = mix(sum, records[0].key ^ records[N - 1].key ^ bitsOf(records[N / 3].score));
        for (u32 w = 0; w < WORDS; w++)
        {
            sorted[w] = words[w];
        }
        quickSort(sorted, (i32)WORDS, [](const char *a, const char *b) { return compare(a, b) < 0; });
        mergeSort(sorted, (const char **)intScratch, WORDS,
            [](const char *a, const char *b) { return length(a) < length(b); });
        sum = mix(sum, hashString(sorted[0]) ^ hashString(sorted[WORDS - 1]));

        // Binary search in the sorted ints.
        quickSort(ints, (i32)N, [](u32 a, u32 b) { return a < b; });
        u32 hits = 0;
        for (u32 k = 0; k < N; k++)
        {
            u32 target = k & 1 ? ints[rng.below(N)] : rng.next();
            u32 lo = 0, hi = N;
            while (lo < hi)
            {
                u32 mid = (lo + hi) >> 1;
                if (ints[mid] < target)
                {
                    lo = mid + 1;
                }
                else
                {
                    hi = mid;
                }
            }
            hits += lo < N && ints[lo] == target;
        }
        sum = mix(sum, hits);

        // LRU cache: node 0 is the sentinel; `where` maps a key to its node.
        memset(where, 0, 4096 * sizeof(u32));
        nodes[0].prev = nodes[0].next = 0;
        u32 used = 0, misses = 0;
        for (u32 k = 0; k < N * 2; k++)
        {
            u32 key = rng.below(k & 1 ? 1536 : 4096);
            u32 n = where[key];
            if (n)
            {
                nodes[nodes[n].prev].next = nodes[n].next;
                nodes[nodes[n].next].prev = nodes[n].prev;
            }
            else
            {
                misses++;
                if (used < LRU)
                {
                    n = ++used;
                }
                else
                {
                    n = nodes[0].prev;
                    nodes[nodes[n].prev].next = 0;
                    nodes[0].prev = nodes[n].prev;
                    where[nodes[n].key] = 0;
                }
                nodes[n].key = key;
                nodes[n].value = key * 2654435761u;
                where[key] = n;
            }
            nodes[n].next = nodes[0].next;
            nodes[n].prev = 0;
            nodes[nodes[0].next].prev = n;
            nodes[0].next = n;
            sum += nodes[n].value >> 28;
        }
        sum = mix(sum, misses);
    }
    return sum;
}
