/* Prefix and postfix increment/decrement. Decrement used to be computed as
   `step - old` instead of `old - step`, which corrupted refcounts and loop
   counters (for example mbedTLS-ish `if (--c->refs == 0)`). */

struct ref {
  int count;
  long pad;
};

static int put(struct ref *c) {
  c->pad = 7;
  if (--c->count == 0) return 100;
  return c->count;
}

static int take(struct ref *c) {
  return c->count--;
}

int main(void) {
  struct ref c;
  int x;

  c.count = 2;
  c.pad = 1;
  if (put(&c) != 1) return 1;
  if (c.count != 1 || c.pad != 7) return 2;
  if (put(&c) != 100) return 3;
  if (c.count != 0) return 4;

  c.count = 5;
  if (take(&c) != 5) return 5;
  if (c.count != 4) return 6;
  if (take(&c) != 4) return 7;
  if (c.count != 3) return 8;

  x = 3;
  if (--x != 2) return 9;
  if (x != 2) return 10;
  if (x-- != 2) return 11;
  if (x != 1) return 12;
  if (++x != 2) return 13;
  if (x != 2) return 14;
  if (x++ != 2) return 15;
  if (x != 3) return 16;
  if (--x != 2 || x-- != 2 || x != 1) return 17;
  if (++x != 2 || x++ != 2 || x != 3) return 18;

  {
    int arr[4];
    int *p = arr;
    arr[0] = 10;
    arr[1] = 20;
    arr[2] = 30;
    arr[3] = 40;
    if (*p++ != 10) return 19;
    if (*p != 20) return 20;
    if (*++p != 30) return 21;
    if (*p-- != 30) return 22;
    if (*p != 20) return 23;
    if (*--p != 10) return 24;
    if (p != arr) return 25;
  }

  {
    unsigned int u = 0;
    if (u-- != 0) return 26;
    if (u != 4294967295u) return 27;
    if (++u != 0) return 28;
    u = 4294967295u;
    if ((u += 1) != 0) return 29;
    if (u != 0) return 30;
    u = 4294967295u;
    if ((u + 1) != 0) return 31;
    if ((u * 2) != 4294967294u) return 32;
  }

  return 0;
}
