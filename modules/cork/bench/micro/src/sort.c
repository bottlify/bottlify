/* Sorting: an insertion-and-quick sort on ints, and a generic sort through a comparator and byte swaps. */
typedef unsigned int u32;
void *memcpy(void *, const void *, u32);
static int a[2000];
typedef struct { u32 key; short w; char tag[6]; } Rec;
static Rec r[600];
static u32 seed;
static u32 rnd(void){ seed = seed * 1664525u + 1013904223u; return seed; }
static void qs(int *v, int lo, int hi){
    while (hi - lo > 12){
        int p = v[(lo + hi) >> 1], i = lo, j = hi;
        while (i <= j){ while (v[i] < p) i++; while (v[j] > p) j--; if (i <= j){ int t = v[i]; v[i] = v[j]; v[j] = t; i++; j--; } }
        if (j - lo < hi - i){ qs(v, lo, j); lo = i; } else { qs(v, i, hi); hi = j; }
    }
    for (int i = lo + 1; i <= hi; i++){ int x = v[i], j = i - 1; while (j >= lo && v[j] > x){ v[j + 1] = v[j]; j--; } v[j + 1] = x; }
}
static int cmp(const void *x, const void *y){ const Rec *p = x, *q = y; return p->key < q->key ? -1 : p->key > q->key; }
static void gsort(void *base, u32 n, u32 size, int (*c)(const void *, const void *)){
    char *b = base; char tmp[64];
    for (u32 gap = n / 2; gap > 0; gap /= 2)
        for (u32 i = gap; i < n; i++)
            for (u32 j = i; j >= gap && c(b + (j - gap) * size, b + j * size) > 0; j -= gap){
                memcpy(tmp, b + j * size, size); memcpy(b + j * size, b + (j - gap) * size, size); memcpy(b + (j - gap) * size, tmp, size);
            }
}
int main(void){
    seed = 99;
    for (int i = 0; i < 2000; i++) a[i] = (int)(rnd() >> 4);
    qs(a, 0, 1999);
    for (int i = 0; i < 600; i++){ r[i].key = rnd() >> 12; r[i].w = (short)i; }
    gsort(r, 600, sizeof(Rec), cmp);
    u32 s = 0;
    for (int i = 0; i < 2000; i += 7) s = s * 3 + (u32)a[i];
    for (int i = 0; i < 600; i += 5) s ^= r[i].key + (u32)r[i].w;
    return s;
}
