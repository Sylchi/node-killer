int add(int a, int b) {
  return a + b;
}

int main() {
  int x = 5;
  int y = 10;
  int result = add(x, y);
  if (result != 15) return 1;
  return 0;
}
