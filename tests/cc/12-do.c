int main() {
  int i = 0;
  int sum = 0;
  do {
    sum = sum + i;
    i = i + 1;
  } while (i < 10);
  if (sum != 45) return 1;
  return 0;
}
