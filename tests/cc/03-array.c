int main() {
  int arr[5];
  for (int i = 0; i < 5; i = i + 1) {
    arr[i] = i * 2;
  }
  if (arr[0] != 0) return 1;
  if (arr[1] != 2) return 2;
  if (arr[2] != 4) return 3;
  if (arr[3] != 6) return 4;
  if (arr[4] != 8) return 5;
  return 0;
}
