const char *msg = "abc";

int main() {
  if (msg[0] != 'a') return 1;
  if (msg[1] != 'b') return 2;
  if (msg[2] != 'c') return 3;
  if (msg[3] != 0) return 4;
  return 0;
}
