struct Point {
  int x;
  int y;
};

int main() {
  struct Point p;
  p.x = 10;
  p.y = 20;
  if (p.x != 10) return 1;
  if (p.y != 20) return 2;
  return 0;
}
