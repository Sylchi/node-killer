/* _Thread_local storage must give every thread its own copy. The JavaScript
   compiler used to ignore the storage class, making the variables ordinary
   globals shared by all worker threads. */

typedef unsigned long pthread_t;

extern int pthread_create(pthread_t *thread, const void *attr,
                          void *(*start)(void *), void *arg);
extern int pthread_join(pthread_t thread, void **retval);

_Thread_local int counter = 5;
static _Thread_local int secret;

static void *worker(void *arg) {
  long id = (long)arg;
  counter += (int)id;
  secret = (int)(id * 10);
  return (void *)(counter + secret);
}

int main(void) {
  pthread_t t1, t2;
  void *r1 = 0;
  void *r2 = 0;

  /* The main thread's copy is independent of the workers' copies. */
  counter = 100;

  if (pthread_create(&t1, 0, worker, (void *)1L) != 0) return 10;
  if (pthread_create(&t2, 0, worker, (void *)2L) != 0) return 11;
  pthread_join(t1, &r1);
  pthread_join(t2, &r2);

  if (counter != 100) return 1;
  if ((long)r1 != 16) return 2;
  if ((long)r2 != 27) return 3;

  secret = 7;
  if (counter != 100 || secret != 7) return 4;
  return 0;
}
