// macOS 26.6.1 arm64 ABI. Unknown ABI/permission failures are fatal.
// See docs/research/macos-process-boundary.md for Apple source and limits.
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <launch.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct identity {
  uint8_t uuid[16];
  uint64_t unique_id, parent_unique_id;
  int32_t version, parent_version;
  uint64_t reserved[2];
};
_Static_assert(sizeof(struct identity) == 56, "process identity ABI");
typedef int (*usage_fn)(uint64_t, void *, size_t);
typedef int (*signal_fn)(const uint32_t *, int);

static void fail(const char *operation) {
  perror(operation);
  exit(1);
}

static uint64_t number(const char *value) {
  char *end;
  errno = 0;
  uint64_t result = strtoull(value, &end, 10);
  if (errno || !*value || *end || !result) { errno = EINVAL; fail("number"); }
  return result;
}

static uint64_t membership(pid_t pid) {
  uint64_t info[5] = {0};
  if (proc_pidinfo(pid, 20, 0, info, sizeof(info)) != sizeof(info)) return 0;
  return info[0];
}

static int identity(pid_t pid, struct identity *info) {
  return proc_pidinfo(pid, 17, 0, info, sizeof(*info)) == sizeof(*info);
}

// A normal launchd resource coalition must not grant explicit coalition
// assignment. Check that privilege before executing any Agent code.
static void require_unprivileged(uint64_t cid) {
  typedef int (*set_fn)(const posix_spawnattr_t *, uint64_t, int, int);
  set_fn set = (set_fn)dlsym(RTLD_DEFAULT, "posix_spawnattr_setcoalition_np");
  if (!set) { errno = ENOSYS; fail("coalition privilege API"); }
  posix_spawnattr_t attr;
  int error = posix_spawnattr_init(&attr);
  if (error) { errno = error; fail("spawn attributes"); }
  error = set(&attr, cid, 0, 0);
  if (error) { errno = error; fail("coalition attributes"); }
  pid_t child;
  char *args[] = {"/usr/bin/true", NULL};
  extern char **environ;
  error = posix_spawn(&child, args[0], NULL, &attr, args, environ);
  posix_spawnattr_destroy(&attr);
  if (!error) waitpid(child, NULL, 0);
  if (error != EPERM) { errno = error ? error : EPERM; fail("privileged resource scope"); }
}

static void usage(uint64_t cid) {
  usage_fn query = (usage_fn)dlsym(RTLD_DEFAULT, "coalition_info_resource_usage");
  if (!query) { errno = ENOSYS; fail("resource API"); }
  uint64_t counters[64] = {0};
  if (query(cid, counters, sizeof(counters))) fail("resource usage");
  if (counters[1] > counters[0]) { errno = EPROTO; fail("resource counters"); }
  printf("{\"started\":\"%llu\",\"exited\":\"%llu\"}\n",
    (unsigned long long)counters[0], (unsigned long long)counters[1]);
}

static int signal_identity(pid_t pid, int32_t version, int signum) {
  signal_fn send = (signal_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  if (!send) { errno = ENOSYS; fail("audit signal API"); }
  uint32_t token[8] = {0};
  token[5] = (uint32_t)pid;
  token[7] = (uint32_t)version;
  return send(token, signum);
}

static void signal_scope(uint64_t cid, int signum) {
  if (cid == membership(getpid())) { errno = EPERM; fail("manager scope"); }
  int count = proc_listallpids(NULL, 0);
  if (count <= 0) fail("enumerate size");
  size_t capacity = (size_t)count + 256;
  pid_t *pids = calloc(capacity, sizeof(pid_t));
  if (!pids) fail("allocate");
  count = proc_listallpids(pids, (int)(capacity * sizeof(pid_t)));
  if (count < 0 || (size_t)count >= capacity) { errno = EAGAIN; fail("enumerate"); }
  unsigned sent = 0;
  for (int i = 0; i < count; i++) {
    struct identity before, after;
    if (!identity(pids[i], &before) || membership(pids[i]) != cid) continue;
    // Capture generation before membership, then recheck it. A later PID reuse
    // is rejected by the kernel's audit-token signal, never by kill(pid).
    if (!identity(pids[i], &after) || before.unique_id != after.unique_id ||
        before.version != after.version) continue;
    int error = signal_identity(pids[i], before.version, signum);
    if (error && error != ESRCH) { errno = error; fail("scope signal"); }
    if (!error) sent++;
  }
  free(pids);
  printf("{\"signalled\":%u}\n", sent);
}

static void sync_directory(int fd) {
  if (fsync(fd)) fail("directory fsync");
}

static void sync_file(int fd) {
  if (fsync(fd) || fcntl(fd, F_FULLFSYNC)) fail("full fsync");
}

static void write_all(int fd, const void *buffer, size_t size) {
  const char *bytes = buffer;
  while (size) {
    ssize_t written = write(fd, bytes, size);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("write");
    bytes += written;
    size -= (size_t)written;
  }
}

static void journal(const char *path, const char *directory, const char *record) {
    char pending[4096];
    int pending_size = snprintf(pending, sizeof(pending), "%s.partial.XXXXXX", path);
    if (pending_size < 0 || (size_t)pending_size >= sizeof(pending)) { errno = ENAMETOOLONG; fail("launch pending path"); }
    int fd = mkstemp(pending);
    if (fd < 0) fail("launch record");
    write_all(fd, record, strlen(record));
    sync_file(fd);
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (parent < 0) fail("launch parent");
    if (renamex_np(pending, path, RENAME_EXCL)) fail("launch admission publish");
    sync_directory(parent);
    close(parent);
    // Flush the volume again after parent metadata reaches the filesystem.
    sync_file(fd);
    if (close(fd)) fail("launch record close");
}

static void copy_tree(int source, int destination, int root) {
  DIR *directory = fdopendir(dup(source));
  if (!directory) fail("fdopendir");
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory))) {
    const char *name = entry->d_name;
    if (!strcmp(name, ".") || !strcmp(name, "..") || !strcmp(name, ".git")) continue;
    if (root && !strcmp(name, ".raven-manifest.json")) {
      errno = EINVAL; fail("reserved manifest");
    }
    struct stat info;
    if (fstatat(source, name, &info, AT_SYMLINK_NOFOLLOW)) fail("lstatat");
    if (S_ISLNK(info.st_mode)) {
      char target[4096];
      ssize_t size = readlinkat(source, name, target, sizeof(target) - 1);
      if (size < 0 || size >= (ssize_t)sizeof(target) - 1) fail("readlinkat");
      target[size] = 0;
      if (symlinkat(target, destination, name)) fail("symlinkat");
    } else {
      int input = openat(source, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      if (input < 0 || fstat(input, &info)) fail("openat source");
      if (S_ISDIR(info.st_mode)) {
        if (mkdirat(destination, name, 0755)) fail("mkdirat");
        int output = openat(destination, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (output < 0) fail("openat destination");
        copy_tree(input, output, 0);
        if (close(output)) fail("close directory");
      } else if (S_ISREG(info.st_mode)) {
        int output = openat(destination, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
        if (output < 0) fail("create file");
        char buffer[65536];
        ssize_t size;
        while ((size = read(input, buffer, sizeof(buffer))) > 0) write_all(output, buffer, (size_t)size);
        if (size < 0) fail("read file");
        if (fchmod(output, info.st_mode & 0111 ? 0755 : 0644)) fail("chmod file");
        sync_file(output);
        if (close(output)) fail("close file");
      } else { errno = EINVAL; fail("unsupported entry"); }
      if (close(input)) fail("close source");
    }
    errno = 0;
  }
  if (errno) fail("readdir");
  if (closedir(directory)) fail("closedir");
  sync_directory(destination);
}

int main(int argc, char **argv) {
  if (argc < 3) { errno = EINVAL; fail("arguments"); }
  if (!strcmp(argv[1], "membership")) {
    pid_t pid = (pid_t)number(argv[2]);
    struct identity info;
    uint64_t cid = membership(pid);
    if (!cid || !identity(pid, &info)) fail("membership");
    printf("{\"coalition\":\"%llu\",\"version\":%d}\n", (unsigned long long)cid, info.version);
  } else if (!strcmp(argv[1], "usage")) {
    usage(number(argv[2]));
  } else if (!strcmp(argv[1], "signal") && argc == 4) {
    signal_scope(number(argv[2]), (int)number(argv[3]));
  } else if (!strcmp(argv[1], "signal-token") && argc == 6) {
    uint64_t cid = number(argv[2]);
    pid_t pid = (pid_t)number(argv[3]);
    if (membership(pid) != cid || cid == membership(getpid())) { errno = EPERM; fail("token scope"); }
    int error = signal_identity(pid, (int32_t)number(argv[4]), (int)number(argv[5]));
    printf("{\"errno\":%d}\n", error);
  } else if (!strcmp(argv[1], "launch") && argc >= 5) {
    // launchd creates the coalition before this program starts. Record it
    // durably before executing any untrusted process or applying Seatbelt.
    uint64_t cid = membership(getpid());
    if (!cid) fail("launch membership");
    require_unprivileged(cid);
    char record[128];
    snprintf(record, sizeof(record), "{\"coalition\":\"%llu\",\"pid\":%d}\n", (unsigned long long)cid, getpid());
    journal(argv[2], argv[3], record);
    unsetenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
    execv(argv[4], &argv[4]);
    fail("execv");
  } else if (!strcmp(argv[1], "broker") && argc >= 5) {
    int *fds = NULL;
    size_t count = 0;
    int error = launch_activate_socket("Model", &fds, &count);
    if (error || count != 1) { errno = error ? error : EPROTO; fail("model activation"); }
    struct sockaddr_in address;
    socklen_t length = sizeof(address);
    if (getsockname(fds[0], (struct sockaddr *)&address, &length) ||
        address.sin_family != AF_INET || address.sin_addr.s_addr != htonl(INADDR_LOOPBACK)) {
      errno = EPROTO; fail("model socket identity");
    }
    int flags = fcntl(fds[0], F_GETFD);
    if (flags < 0 || fcntl(fds[0], F_SETFD, flags & ~FD_CLOEXEC)) fail("model fd inheritance");
    char record[64], descriptor[32];
    snprintf(record, sizeof(record), "{\"port\":%u}\n", ntohs(address.sin_port));
    journal(argv[2], argv[3], record);
    snprintf(descriptor, sizeof(descriptor), "%d", fds[0]);
    if (setenv("RAVEN_EGRESS_FD", descriptor, 1)) fail("model fd environment");
    free(fds);
    execv(argv[4], &argv[4]);
    fail("broker execv");
  } else if (!strcmp(argv[1], "copy") && argc == 4) {
    int source = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    int destination = open(argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (source < 0 || destination < 0) fail("snapshot root");
    copy_tree(source, destination, 1);
    close(source);
    close(destination);
  } else if (!strcmp(argv[1], "publish") && argc == 5) {
    if (renamex_np(argv[2], argv[3], RENAME_EXCL)) fail("exclusive publish");
    int parent = open(argv[4], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (parent < 0) fail("publish parent");
    sync_directory(parent);
    close(parent);
    char marker[4096];
    int size = snprintf(marker, sizeof(marker), "%s/.raven-manifest.json", argv[3]);
    if (size < 0 || (size_t)size >= sizeof(marker)) { errno = ENAMETOOLONG; fail("publish marker path"); }
    int fd = open(marker, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) fail("publish barrier");
    sync_file(fd);
    close(fd);
  } else if (!strcmp(argv[1], "journal") && argc == 5) {
    journal(argv[2], argv[3], argv[4]);
  } else if (!strcmp(argv[1], "sync")) {
    int fd = open(argv[2], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    struct stat info;
    if (fd < 0 || fstat(fd, &info)) fail("sync open");
    if (S_ISDIR(info.st_mode)) sync_directory(fd); else if (S_ISREG(info.st_mode)) sync_file(fd);
    else { errno = EINVAL; fail("sync entry"); }
    close(fd);
  } else { errno = EINVAL; fail("unknown command"); }
  return 0;
}
