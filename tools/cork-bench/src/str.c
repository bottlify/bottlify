/* Strings: a hash table of names looked up by string, formatting numbers, comparing -- a resource manager's work. */
typedef unsigned int u32;
u32 strlen(const char *); int strcmp(const char *, const char *); void *memcpy(void *, const void *, u32);
typedef struct Ent { char name[24]; u32 value; struct Ent *next; } Ent;
static Ent ents[512];
static Ent *buckets[128];
static u32 hashs(const char *s){ u32 h = 2166136261u; while (*s) h = (h ^ (unsigned char)*s++) * 16777619u; return h; }
static char *utoa(u32 v, char *out){ char t[12]; int n = 0; do { t[n++] = (char)('0' + v % 10); v /= 10; } while (v); while (n) *out++ = t[--n]; *out = 0; return out; }
static void mkname(char *b, const char *prefix, u32 i){ u32 n = strlen(prefix); memcpy(b, prefix, n); b[n] = '_'; utoa(i * 7919u, b + n + 1); }
static Ent *lookup(const char *s){ for (Ent *e = buckets[hashs(s) & 127]; e; e = e->next) if (!strcmp(e->name, s)) return e; return 0; }
int main(void){
    static const char *pre[4] = { "textures/wall", "sound/step", "models/crate", "gfx/ui" };
    for (int i = 0; i < 128; i++) buckets[i] = 0;
    for (int i = 0; i < 512; i++){
        Ent *e = &ents[i]; mkname(e->name, pre[i & 3], (u32)i); e->value = (u32)i * 3u;
        u32 h = hashs(e->name) & 127; e->next = buckets[h]; buckets[h] = e;
    }
    u32 sum = 0; char q[32];
    for (int k = 0; k < 1200; k++){
        mkname(q, pre[k & 3], (u32)(k * 5 % 700));
        Ent *e = lookup(q); sum += e ? e->value : strlen(q);
    }
    return sum;
}
