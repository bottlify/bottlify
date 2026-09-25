/* One frame of a game's update: entities moved by a physics step, collisions on a grid, an AI decision by
   calls through a table, a string of events -- a mix of every kind, integer and float. */
typedef unsigned int u32;
typedef struct Ent { float px, py, vx, vy; int kind, hp, cell, target; u32 flags; } Ent;
static Ent e[300];
static short grid[32 * 32];
static int next[300];
static u32 seed = 1;
static u32 rnd(void){ seed = seed * 214013u + 2531011u; return (seed >> 16) & 0x7fff; }
static int think0(Ent *x){ return x->hp < 20 ? 1 : 0; }
static int think1(Ent *x){ return x->target >= 0 ? 2 : (int)(rnd() & 3); }
static int think2(Ent *x){ x->flags ^= 4; return (int)(x->flags & 3); }
static int (*const think[3])(Ent *) = { think0, think1, think2 };
static void step(Ent *x, float dt){
    x->vy -= 9.8f * dt; x->px += x->vx * dt; x->py += x->vy * dt;
    if (x->py < 0){ x->py = 0; x->vy = -x->vy * 0.5f; }
    if (x->px < 0 || x->px > 255){ x->vx = -x->vx; x->px = x->px < 0 ? 0 : 255; }
}
static int once;
int main(void){
    if (!once){ for (int i = 0; i < 300; i++){ e[i].px = (float)(rnd() & 255); e[i].py = (float)(rnd() & 127); e[i].vx = (float)((int)(rnd() & 15) - 7); e[i].vy = 0; e[i].kind = i % 3; e[i].hp = 100; e[i].target = -1; e[i].flags = 0; } once = 1; }
    u32 score = 0;
    for (int f = 0; f < 6; f++){
        for (int c = 0; c < 32 * 32; c++) grid[c] = -1;
        for (int i = 0; i < 300; i++){
            Ent *x = &e[i];
            step(x, 0.016f);
            int cx = (int)x->px >> 3, cy = (int)x->py >> 3; if (cy > 31) cy = 31;
            x->cell = cy * 32 + cx; next[i] = grid[x->cell]; grid[x->cell] = (short)i;
        }
        for (int i = 0; i < 300; i++){
            Ent *x = &e[i];
            for (int j = next[i]; j >= 0; j = next[j]){ float dx = e[j].px - x->px, dy = e[j].py - x->py; if (dx * dx + dy * dy < 4.0f){ x->hp--; x->target = j; score += (u32)j; } }
            int act = think[x->kind](x);
            if (act == 1) x->vx = -x->vx; else if (act == 2) x->target = -1;
            score = score * 33u + (u32)act + (u32)x->hp;
        }
    }
    return (int)score;
}
