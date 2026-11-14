/* A CRC-32 over a table and an LZ77-shaped decoder: byte loads and stores, the archive reader's work. */
typedef unsigned int u32; typedef unsigned char u8;
static u32 table[256];
static u8 src[8192], packed[12000], out[8192];
static void mktable(void){ for (u32 i = 0; i < 256; i++){ u32 c = i; for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1; table[i] = c; } }
static u32 crc(const u8 *p, u32 n){ u32 c = 0xffffffffu; while (n--) c = table[(c ^ *p++) & 0xff] ^ (c >> 8); return ~c; }
/* token: flag byte, then 8 items: literal byte or (offset:12, len:4) pair */
static u32 pack(const u8 *s, u32 n, u8 *o){
    u32 i = 0, w = 0;
    while (i < n){
        u32 fl = w++; u8 flags = 0;
        for (int b = 0; b < 8 && i < n; b++){
            u32 best = 0, bo = 0;
            u32 lim = i > 4095 ? i - 4095 : 0;
            for (u32 j = i > 64 ? i - 64 : 0; j < i && j >= lim; j++){ u32 l = 0; while (l < 18 && i + l < n && s[j + l] == s[i + l]) l++; if (l > best){ best = l; bo = i - j; } }
            if (best >= 3){ flags |= (u8)(1 << b); o[w++] = (u8)(bo & 0xff); o[w++] = (u8)(((bo >> 8) << 4) | (best - 3)); i += best; }
            else o[w++] = s[i++];
        }
        o[fl] = flags;
    }
    return w;
}
static u32 unpack(const u8 *p, u32 n, u8 *o){
    const u8 *e = p + n; u32 w = 0;
    while (p < e){
        u8 f = *p++;
        for (int b = 0; b < 8 && p < e; b++){
            if (f & (1 << b)){ u32 off = p[0] | ((p[1] >> 4) << 8), len = (p[1] & 15) + 3; p += 2; while (len--){ o[w] = o[w - off]; w++; } }
            else o[w++] = *p++;
        }
    }
    return w;
}
static int once;
static u32 plen;
int main(void){
    if (!once){
        mktable(); u32 x = 7;
        for (int i = 0; i < 8192; i++){ x = x * 1103515245u + 12345u; src[i] = (u8)((x >> 16) % 7 + 'a' + ((i >> 6) & 3)); }
        plen = pack(src, 8192, packed); once = 1;
    }
    u32 s = 0;
    for (int k = 0; k < 3; k++){ u32 n = unpack(packed, plen, out); s += crc(out, n); }
    return s;
}
