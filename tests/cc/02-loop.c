int main() {
  int sum = 0;
  for (int i = 1; i <= 10; i = i + 1) {
    sum = sum + i;
  }
  if (sum != 55) return 1;
  return 0;
}
