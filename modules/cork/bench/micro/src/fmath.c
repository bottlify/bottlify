/* Float math the way a renderer and a physics step of the era do it: transforms, dot products,
   normalisation, a frustum test with compares, float-to-int conversion. Built for x87 and for SSE. */
typedef unsigned int u32;
typedef struct { float x, y, z; } V3;
typedef struct { float m[4][4]; } M4;
static V3 pts[512], outp[512];
static float planes[6][4];
static M4 mat;
static float sqrtf_(float x){ return __builtin_sqrtf(x); }
static float dot(const V3 *a, const V3 *b){ return a->x * b->x + a->y * b->y + a->z * b->z; }
static void xform(const M4 *m, const V3 *v, V3 *o){
    o->x = m->m[0][0] * v->x + m->m[1][0] * v->y + m->m[2][0] * v->z + m->m[3][0];
    o->y = m->m[0][1] * v->x + m->m[1][1] * v->y + m->m[2][1] * v->z + m->m[3][1];
    o->z = m->m[0][2] * v->x + m->m[1][2] * v->y + m->m[2][2] * v->z + m->m[3][2];
}
static void norm(V3 *v){ float l = sqrtf_(dot(v, v)); if (l > 1e-6f){ float r = 1.0f / l; v->x *= r; v->y *= r; v->z *= r; } }
static int cull(const V3 *p, float rad){ for (int i = 0; i < 6; i++) if (planes[i][0] * p->x + planes[i][1] * p->y + planes[i][2] * p->z + planes[i][3] < -rad) return 1; return 0; }
static int once;
int main(void){
    if (!once){
        for (int i = 0; i < 512; i++){ pts[i].x = (float)(i % 17) - 8.0f; pts[i].y = (float)(i % 23) * 0.5f - 5.0f; pts[i].z = (float)(i % 11) + 1.0f; }
        for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) mat.m[i][j] = (i == j) ? 0.9f : 0.05f * (float)(i - j);
        for (int i = 0; i < 6; i++){ planes[i][0] = (float)(i & 1) - 0.5f; planes[i][1] = (float)((i >> 1) & 1) - 0.5f; planes[i][2] = 0.7f; planes[i][3] = 6.0f; }
        once = 1;
    }
    int vis = 0; float acc = 0;
    for (int k = 0; k < 4; k++)
        for (int i = 0; i < 512; i++){
            xform(&mat, &pts[i], &outp[i]);
            norm(&outp[i]);
            if (!cull(&pts[i], 0.5f)){ vis++; acc += dot(&outp[i], &pts[i]); }
        }
    return vis + (int)(acc * 16.0f);
}
