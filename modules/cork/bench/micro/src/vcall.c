/* Objects with a table of methods called through it, the way C++ virtual calls compile. */
typedef unsigned int u32;
typedef struct Obj Obj;
typedef struct { void (*update)(Obj *, int); int (*alive)(const Obj *); u32 (*hash)(const Obj *); } VT;
struct Obj { const VT *vt; int x, y, vx, vy, hp; u32 id; };
static void upA(Obj *o, int dt){ o->x += o->vx * dt; o->y += o->vy * dt; if (o->x > 1000 || o->x < -1000) o->vx = -o->vx; }
static void upB(Obj *o, int dt){ o->hp -= dt; o->y -= o->vy; if (o->hp < 0) o->hp = 100; }
static void upC(Obj *o, int dt){ o->vx += (o->x < 0) ? dt : -dt; o->x += o->vx; }
static int aliveA(const Obj *o){ return o->hp > 0; }
static int aliveB(const Obj *o){ return o->hp > 10 && o->y > -5000; }
static u32 hashA(const Obj *o){ return (u32)o->x * 31u + (u32)o->y + o->id; }
static u32 hashB(const Obj *o){ return ((u32)o->hp << 16) ^ (u32)o->x ^ o->id; }
static const VT vtA = { upA, aliveA, hashA }, vtB = { upB, aliveB, hashB }, vtC = { upC, aliveA, hashB };
static Obj objs[256];
int main(void){
    for (int i = 0; i < 256; i++){
        Obj *o = &objs[i];
        o->vt = i % 3 == 0 ? &vtA : i % 3 == 1 ? &vtB : &vtC;
        o->x = i * 7; o->y = i * 13; o->vx = (i & 7) - 3; o->vy = (i & 3) - 1; o->hp = 50 + i; o->id = i;
    }
    u32 sum = 0;
    for (int f = 0; f < 40; f++)
        for (int i = 0; i < 256; i++){
            Obj *o = &objs[i];
            o->vt->update(o, 2);
            if (o->vt->alive(o)) sum += o->vt->hash(o);
        }
    return sum;
}
