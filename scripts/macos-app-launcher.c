#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int file_exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0 && S_ISREG(info.st_mode);
}

static void show_error(const char *message) {
  execl(
    "/usr/bin/osascript",
    "osascript",
    "-e",
    "display alert \"KStock Trader 실행 실패\" message \"프로그램 본체 또는 Node.js 22 이상을 찾지 못했습니다.\" as critical",
    (char *)NULL
  );
  fprintf(stderr, "%s\n", message);
}

int main(int argc, char **argv) {
  // The native bundle entry point keeps Finder launches console-free.
  char executable_path[PATH_MAX];
  uint32_t executable_path_size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
    show_error("Failed to resolve the application executable path.");
    return 1;
  }

  char resolved_executable[PATH_MAX];
  if (realpath(executable_path, resolved_executable) == NULL) {
    show_error("Failed to normalize the application executable path.");
    return 1;
  }

  char path_buffer[PATH_MAX];
  snprintf(path_buffer, sizeof(path_buffer), "%s", resolved_executable);
  char *current = dirname(path_buffer);
  for (int level = 0; level < 4; level += 1) current = dirname(current);

  char project_root[PATH_MAX];
  snprintf(project_root, sizeof(project_root), "%s", current);
  char package_path[PATH_MAX];
  char launcher_path[PATH_MAX];
  snprintf(package_path, sizeof(package_path), "%s/package.json", project_root);
  snprintf(launcher_path, sizeof(launcher_path), "%s/scripts/desktop-launcher.mjs", project_root);
  if (!file_exists(package_path) || !file_exists(launcher_path)) {
    show_error("KStock Trader project files were not found.");
    return 1;
  }

  const char *existing_path = getenv("PATH");
  char runtime_path[PATH_MAX * 2];
  snprintf(
    runtime_path,
    sizeof(runtime_path),
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin%s%s",
    existing_path == NULL || existing_path[0] == '\0' ? "" : ":",
    existing_path == NULL ? "" : existing_path
  );
  setenv("PATH", runtime_path, 1);

  char **node_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (node_argv == NULL) {
    show_error("Failed to allocate launcher arguments.");
    return 1;
  }
  node_argv[0] = "node";
  node_argv[1] = launcher_path;
  for (int index = 1; index < argc; index += 1) node_argv[index + 1] = argv[index];
  node_argv[argc + 1] = NULL;
  execvp("node", node_argv);

  free(node_argv);
  show_error("Failed to start Node.js.");
  return 1;
}
