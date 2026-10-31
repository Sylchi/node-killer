int add(int a, int b) { return a + b; }

int apply(int (*f)(int, int), int a, int b) {
  return f(a, b);
}

int main() {
  int r = apply(add, 5, 10);
  if (r != 15) return 1;
  return 0;
}
