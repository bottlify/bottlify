/* A binary search tree over a pool: inserts, lookups, a recursive walk -- pointer chasing and calls. */
typedef unsigned int u32;
typedef struct Node { struct Node *l, *r; u32 key; u32 val; } Node;
static Node pool[4096];
static int used;
static u32 seed = 12345;
static u32 rnd(void){ seed = seed * 1103515245u + 12345u; return seed >> 8; }
static Node *insert(Node *n, u32 key){
    if (!n){ Node *m = &pool[used++]; m->l = m->r = 0; m->key = key; m->val = key ^ 0x5a5a; return m; }
    if (key < n->key) n->l = insert(n->l, key);
    else if (key > n->key) n->r = insert(n->r, key);
    else n->val++;
    return n;
}
static Node *find(Node *n, u32 key){
    while (n && n->key != key) n = key < n->key ? n->l : n->r;
    return n;
}
static u32 walk(Node *n){ return n ? walk(n->l) + n->val + walk(n->r) * 3 : 0; }
int main(void){
    used = 0; seed = 12345;
    Node *root = 0;
    for (int i = 0; i < 1500; i++) root = insert(root, rnd() & 0xffff);
    u32 sum = 0;
    for (int i = 0; i < 3000; i++){ Node *f = find(root, rnd() & 0xffff); if (f) sum += f->val; }
    return sum + walk(root);
}
