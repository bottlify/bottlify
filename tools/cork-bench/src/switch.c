/* A script's tokenizer and a message pump: switch statements over a character class and a message type,
   the way a game parses its config and dispatches its events. */
typedef unsigned int u32;
enum { M_MOVE, M_FIRE, M_HIT, M_PICK, M_OPEN, M_CLOSE, M_SAY, M_DIE, M_SPAWN, M_TICK, M_SOUND, M_NONE };
typedef struct { int type, a, b; } Msg;
static Msg queue[512];
static int hp[64], ammo[64], pos[64], doors[16];
static char text[4096];
static u32 seed = 7;
static u32 rnd(void){ seed = seed * 1103515245u + 12345u; return seed >> 16; }
static u32 dispatch(const Msg *m){
    switch (m->type){
    case M_MOVE: pos[m->a & 63] += m->b; return 1;
    case M_FIRE: if (ammo[m->a & 63] > 0){ ammo[m->a & 63]--; return 2; } return 0;
    case M_HIT: hp[m->a & 63] -= m->b & 15; return hp[m->a & 63] < 0 ? 7 : 3;
    case M_PICK: ammo[m->a & 63] += 5; return 4;
    case M_OPEN: doors[m->b & 15] = 1; return 5;
    case M_CLOSE: doors[m->b & 15] = 0; return 6;
    case M_SAY: return (u32)(m->a ^ m->b) & 7;
    case M_DIE: hp[m->a & 63] = 100; return 8;
    case M_SPAWN: pos[m->a & 63] = m->b; ammo[m->a & 63] = 10; return 9;
    case M_TICK: return (u32)pos[m->a & 63];
    case M_SOUND: return 11;
    default: return 0;
    }
}
static int cls(int c){ return c >= 'a' && c <= 'z' ? 0 : c >= '0' && c <= '9' ? 1 : c == ' ' || c == '\n' ? 2 : c == '"' ? 3 : c == '/' ? 4 : 5; }
static u32 tokenize(const char *s, int n){
    u32 h = 0, tokens = 0; int state = 0;
    for (int i = 0; i < n; i++){
        int c = s[i];
        switch (state * 6 + cls(c)){
        case 0: case 1: state = 1; h = c; break;
        case 2: break;
        case 3: state = 2; h = 0; break;
        case 4: state = 3; break;
        case 5: tokens++; break;
        case 6: case 7: h = h * 31 + (u32)c; break;
        case 8: tokens++; h ^= h >> 7; state = 0; break;
        case 9: case 10: case 11: tokens++; state = 0; break;
        case 12: case 13: case 14: case 16: case 17: h = h * 7 + (u32)c; break;
        case 15: tokens++; state = 0; break;
        case 18: case 19: case 20: case 21: case 23: state = c == '\n' ? 0 : 3; break;
        case 22: state = 3; break;
        }
    }
    return tokens * 131 + h;
}
static int once;
int main(void){
    if (!once){
        for (int i = 0; i < 4096; i++){ u32 r = rnd() % 40; text[i] = (char)(r < 20 ? 'a' + r : r < 28 ? '0' + r - 20 : r < 34 ? ' ' : r < 36 ? '"' : r < 37 ? '/' : r < 39 ? '\n' : '='); }
        once = 1;
    }
    u32 s = 0;
    for (int k = 0; k < 8; k++){
        for (int i = 0; i < 512; i++){ queue[i].type = (int)(rnd() % 12); queue[i].a = (int)rnd(); queue[i].b = (int)rnd(); }
        for (int i = 0; i < 512; i++) s = s * 3 + dispatch(&queue[i]);
    }
    s += tokenize(text, 4096);
    return (int)s;
}
