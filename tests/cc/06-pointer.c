int main() {
  int x = 10;
  int *ptr = &x;
  *ptr = 20;
  if (x != 20) return 1;
  return 0;
}
