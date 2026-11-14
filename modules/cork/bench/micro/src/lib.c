typedef unsigned int u32;
typedef unsigned char u8;
void *memcpy(void *d, const void *s, u32 n){ u8 *a=d; const u8 *b=s; while(n--) *a++=*b++; return d; }
void *memset(void *d, int c, u32 n){ u8 *a=d; while(n--) *a++=(u8)c; return d; }
void *memmove(void *d, const void *s, u32 n){ u8 *a=d; const u8 *b=s; if(a<b){while(n--)*a++=*b++;} else {a+=n;b+=n;while(n--)*--a=*--b;} return d; }
int memcmp(const void *x, const void *y, u32 n){ const u8 *a=x,*b=y; for(;n;n--,a++,b++) if(*a!=*b) return *a-*b; return 0; }
u32 strlen(const char *s){ const char *p=s; while(*p) p++; return p-s; }
int strcmp(const char *a, const char *b){ while(*a && *a==*b){a++;b++;} return (u8)*a-(u8)*b; }
