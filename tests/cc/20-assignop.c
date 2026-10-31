/* Compound assignments must evaluate as `lhs op rhs`, not `rhs op lhs`.
   The non-commutative operators (-=, /=, %=, <<=, >>=) used to be reversed,
   which made loops such as ns_csum_add() never terminate. */

static int sum16(const unsigned char *p, unsigned long len) {
  int sum = 0;
  while (len > 1) {
    sum += p[0];
    p += 2;
    len -= 2;
  }
  return sum;
}

struct pair {
  int a;
  int b;
};

static int test_int(void) {
  int x = 20;
  x -= 3;
  if (x != 17) return 2;
  x /= 2;
  if (x != 8) return 3;
  x %= 5;
  if (x != 3) return 4;
  x <<= 4;
  if (x != 48) return 5;
  x >>= 2;
  if (x != 12) return 6;
  x *= 3;
  if (x != 36) return 7;
  x |= 3;
  if (x != 39) return 8;
  x &= 15;
  if (x != 7) return 9;
  x ^= 5;
  if (x != 2) return 10;
  return 0;
}

static int test_unsigned(void) {
  unsigned int u = 100;
  u -= 40;
  if (u != 60) return 11;
  u /= 3;
  if (u != 20) return 12;
  u %= 7;
  if (u != 6) return 13;
  u >>= 1;
  if (u != 3) return 14;
  return 0;
}

static int test_member(void) {
  struct pair st;
  st.a = 10;
  st.b = 5;
  st.a -= st.b;
  if (st.a != 5) return 15;
  st.b <<= 3;
  if (st.b != 40) return 16;
  return 0;
}

static int test_pointer(void) {
  int arr[3];
  int *q;
  arr[0] = 10;
  arr[1] = 20;
  arr[2] = 30;
  q = arr + 2;
  q -= 1;
  if (*q != 20) return 17;
  *q -= 4;
  if (arr[1] != 16) return 18;
  return 0;
}

static int test_float(void) {
  double d = 10.0;
  d -= 2.5;
  if (d < 7.49 || d > 7.51) return 19;
  d /= 2.0;
  if (d < 3.74 || d > 3.76) return 20;
  d *= 4.0;
  if (d < 14.99 || d > 15.01) return 21;
  return 0;
}

int main(void) {
  unsigned char buf[8];
  int rc;
  int i;

  for (i = 0; i < 8; i = i + 1) buf[i] = (unsigned char)(i + 1);
  if (sum16(buf, 8) != 16) return 1;

  rc = test_int();
  if (rc) return rc;
  rc = test_unsigned();
  if (rc) return rc;
  rc = test_member();
  if (rc) return rc;
  rc = test_pointer();
  if (rc) return rc;
  rc = test_float();
  if (rc) return rc;

  return 0;
}
