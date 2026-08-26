#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>

static napi_value throw_native_error(napi_env env, const char *operation) {
  char message[256];
  (void)snprintf(message, sizeof(message), "%s failed: %s", operation, strerror(errno));
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value uint64_string(napi_env env, uint64_t value) {
  char buffer[32];
  int length = snprintf(buffer, sizeof(buffer), "%" PRIu64, value);
  napi_value result;
  if (length <= 0 || (size_t)length >= sizeof(buffer) ||
      napi_create_string_utf8(env, buffer, (size_t)length, &result) != napi_ok) {
    napi_throw_error(env, NULL, "failed to encode process birth timestamp");
    return NULL;
  }
  return result;
}

static napi_value get_process_start_identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_type_error(env, NULL, "getProcessStartIdentity requires a positive pid");
    return NULL;
  }

  struct proc_bsdinfo process_info;
  memset(&process_info, 0, sizeof(process_info));
  errno = 0;
  int received = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process_info, sizeof(process_info));
  if (received <= 0) return throw_native_error(env, "proc_pidinfo(PROC_PIDTBSDINFO)");
  if ((size_t)received != sizeof(process_info) || process_info.pbi_pid != (uint32_t)pid ||
      process_info.pbi_start_tvsec == 0 || process_info.pbi_start_tvusec >= 1000000) {
    napi_throw_error(env, NULL, "proc_pidinfo returned incomplete process birth identity");
    return NULL;
  }

  napi_value result;
  napi_value pid_value;
  napi_value seconds = uint64_string(env, process_info.pbi_start_tvsec);
  if (seconds == NULL) return NULL;
  napi_value microseconds = uint64_string(env, process_info.pbi_start_tvusec);
  if (microseconds == NULL) return NULL;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_int32(env, pid, &pid_value) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid_value) != napi_ok ||
      napi_set_named_property(env, result, "startSeconds", seconds) != napi_ok ||
      napi_set_named_property(env, result, "startMicroseconds", microseconds) != napi_ok) {
    napi_throw_error(env, NULL, "failed to create process birth identity result");
    return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "getProcessStartIdentity", NAPI_AUTO_LENGTH,
                           get_process_start_identity, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getProcessStartIdentity", function) != napi_ok) {
    napi_throw_error(env, NULL, "failed to initialize process-start native binding");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
