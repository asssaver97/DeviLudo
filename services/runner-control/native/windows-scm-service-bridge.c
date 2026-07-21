#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

#define DEVILUDO_BRIDGE_VERSION L"1.0.0"
#define DEVILUDO_BRIDGE_CONTRACT_VERSION 1UL
#define DEVILUDO_MAX_PATH_CHARS 32767UL
#define DEVILUDO_MAX_ENV_BYTES (256UL * 1024UL)
#define DEVILUDO_MAX_TARGET_BYTES (512ULL * 1024ULL * 1024ULL)
#define DEVILUDO_HASH_BYTES 32UL
#define DEVILUDO_HASH_HEX_CHARS 64UL

static const wchar_t *PHYSICAL_RUNNER_SERVICE = L"DeviLudoPhysicalRunner";
static const wchar_t *STEAM_CONNECTOR_SERVICE = L"DeviLudoSteamConnector";
static const wchar_t *PHYSICAL_RUNNER_FILE = L"deviludo-physical-runner.exe";
static const wchar_t *STEAM_CONNECTOR_FILE = L"deviludo-steam-client-connector.exe";

typedef struct bridge_configuration {
  wchar_t *target_executable;
  wchar_t target_digest[DEVILUDO_HASH_HEX_CHARS + 1];
  wchar_t descriptor_digest[DEVILUDO_HASH_HEX_CHARS + 1];
  wchar_t *environment;
  DWORD environment_bytes;
} bridge_configuration;

static SERVICE_STATUS_HANDLE service_status_handle = NULL;
static SERVICE_STATUS service_status;
static HANDLE stop_event = NULL;
static HANDLE child_process = NULL;
static HANDLE child_job = NULL;

static void secure_free(void *value, SIZE_T bytes) {
  if (value != NULL) {
    SecureZeroMemory(value, bytes);
    HeapFree(GetProcessHeap(), 0, value);
  }
}

static void report_status(DWORD state, DWORD win32_exit, DWORD wait_hint) {
  static DWORD checkpoint = 1;
  service_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  service_status.dwCurrentState = state;
  service_status.dwWin32ExitCode = win32_exit;
  service_status.dwServiceSpecificExitCode = 0;
  service_status.dwWaitHint = wait_hint;
  service_status.dwControlsAccepted = state == SERVICE_RUNNING
    ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  service_status.dwCheckPoint = state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING
    ? checkpoint++ : 0;
  if (service_status_handle != NULL) {
    SetServiceStatus(service_status_handle, &service_status);
  }
}

static DWORD WINAPI service_control(DWORD control, DWORD event_type, void *event_data, void *context) {
  (void) event_type;
  (void) event_data;
  (void) context;
  if ((control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN)
      && service_status.dwCurrentState == SERVICE_RUNNING) {
    report_status(SERVICE_STOP_PENDING, NO_ERROR, 15000);
    if (stop_event != NULL) SetEvent(stop_event);
  }
  return NO_ERROR;
}

static int is_allowed_service(const wchar_t *service_name, const wchar_t **expected_file) {
  if (service_name != NULL && wcscmp(service_name, PHYSICAL_RUNNER_SERVICE) == 0) {
    *expected_file = PHYSICAL_RUNNER_FILE;
    return 1;
  }
  if (service_name != NULL && wcscmp(service_name, STEAM_CONNECTOR_SERVICE) == 0) {
    *expected_file = STEAM_CONNECTOR_FILE;
    return 1;
  }
  return 0;
}

static int lowercase_hex_digest(const wchar_t *value) {
  DWORD index;
  if (value == NULL || wcslen(value) != DEVILUDO_HASH_HEX_CHARS) return 0;
  for (index = 0; index < DEVILUDO_HASH_HEX_CHARS; index++) {
    wchar_t character = value[index];
    if (!((character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f'))) return 0;
  }
  return 1;
}

static int safe_environment_name(const wchar_t *name, SIZE_T length) {
  SIZE_T index;
  if (length < 1 || !(name[0] >= L'A' && name[0] <= L'Z')) return 0;
  for (index = 1; index < length; index++) {
    wchar_t character = name[index];
    if (!((character >= L'A' && character <= L'Z')
      || (character >= L'0' && character <= L'9') || character == L'_')) return 0;
  }
  return 1;
}

static int credential_name_is_inline(const wchar_t *name, SIZE_T length) {
  static const wchar_t *blocked[] = {
    L"API_KEY", L"PASSWORD", L"TOKEN", L"SECRET", L"SESSION", L"PRIVATE_KEY"
  };
  SIZE_T index;
  for (index = 0; index < sizeof(blocked) / sizeof(blocked[0]); index++) {
    SIZE_T suffix_length = wcslen(blocked[index]);
    if (length >= suffix_length && _wcsnicmp(name + length - suffix_length, blocked[index], suffix_length) == 0) {
      return 1;
    }
  }
  return 0;
}

static SIZE_T bounded_wcs_length(const wchar_t *value, SIZE_T maximum) {
  SIZE_T length = 0;
  while (length < maximum && value[length] != L'\0') length++;
  return length;
}

static int validate_environment_block(const wchar_t *environment, DWORD bytes) {
  const wchar_t *cursor = environment;
  const wchar_t *end;
  wchar_t previous_name[256];
  wchar_t current_name[256];
  SIZE_T previous_length = 0;
  if (environment == NULL || bytes < 4 || bytes > DEVILUDO_MAX_ENV_BYTES || bytes % sizeof(wchar_t) != 0) return 0;
  end = environment + (bytes / sizeof(wchar_t));
  previous_name[0] = L'\0';
  while (cursor < end && *cursor != L'\0') {
    const wchar_t *separator = wcschr(cursor, L'=');
    SIZE_T entry_length = bounded_wcs_length(cursor, (SIZE_T) (end - cursor));
    SIZE_T name_length;
    SIZE_T index;
    if (entry_length == 0 || cursor + entry_length >= end || separator == NULL || separator >= cursor + entry_length) return 0;
    name_length = (SIZE_T) (separator - cursor);
    if (name_length >= sizeof(previous_name) / sizeof(previous_name[0])
      || !safe_environment_name(cursor, name_length) || credential_name_is_inline(cursor, name_length)) return 0;
    for (index = name_length + 1; index < entry_length; index++) {
      if (cursor[index] == L'\r' || cursor[index] == L'\n' || cursor[index] == L'\0') return 0;
    }
    wmemcpy(current_name, cursor, name_length);
    current_name[name_length] = L'\0';
    if (previous_length > 0 && wcscmp(previous_name, current_name) >= 0) return 0;
    wcscpy_s(previous_name, sizeof(previous_name) / sizeof(previous_name[0]), current_name);
    previous_length = name_length;
    cursor += entry_length + 1;
  }
  return cursor + 2 == end && cursor[0] == L'\0' && cursor[1] == L'\0';
}

static LONG read_registry_string(HKEY key, const wchar_t *name, wchar_t **output, DWORD maximum_chars) {
  DWORD type = 0;
  DWORD bytes = 0;
  LONG result = RegGetValueW(key, NULL, name, RRF_RT_REG_SZ, &type, NULL, &bytes);
  wchar_t *value;
  if (result != ERROR_SUCCESS || bytes < sizeof(wchar_t) * 2 || bytes > maximum_chars * sizeof(wchar_t)) return ERROR_INVALID_DATA;
  value = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes + sizeof(wchar_t));
  if (value == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  result = RegGetValueW(key, NULL, name, RRF_RT_REG_SZ, &type, value, &bytes);
  if (result != ERROR_SUCCESS || value[(bytes / sizeof(wchar_t)) - 1] != L'\0') {
    secure_free(value, bytes + sizeof(wchar_t));
    return ERROR_INVALID_DATA;
  }
  *output = value;
  return ERROR_SUCCESS;
}

static LONG read_registry_environment(HKEY key, wchar_t **output, DWORD *output_bytes) {
  DWORD type = 0;
  DWORD bytes = 0;
  LONG result = RegGetValueW(key, NULL, L"Environment", RRF_RT_REG_MULTI_SZ, &type, NULL, &bytes);
  wchar_t *value;
  if (result != ERROR_SUCCESS || bytes < sizeof(wchar_t) * 2 || bytes > DEVILUDO_MAX_ENV_BYTES) return ERROR_INVALID_DATA;
  value = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes + sizeof(wchar_t) * 2);
  if (value == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  result = RegGetValueW(key, NULL, L"Environment", RRF_RT_REG_MULTI_SZ, &type, value, &bytes);
  if (result != ERROR_SUCCESS || !validate_environment_block(value, bytes)) {
    secure_free(value, bytes + sizeof(wchar_t) * 2);
    return ERROR_INVALID_DATA;
  }
  *output = value;
  *output_bytes = bytes;
  return ERROR_SUCCESS;
}

static int canonical_target_path(const wchar_t *value, const wchar_t *expected_file) {
  wchar_t *canonical = NULL;
  wchar_t *file_part = NULL;
  DWORD required;
  int valid = 0;
  SIZE_T length;
  if (value == NULL || expected_file == NULL) return 0;
  length = wcslen(value);
  if (length < 4 || length >= DEVILUDO_MAX_PATH_CHARS || value[1] != L':' || value[2] != L'\\'
    || value[0] == L'\\' || wcsstr(value, L"..") != NULL || wcschr(value, L'/') != NULL) return 0;
  required = GetFullPathNameW(value, 0, NULL, NULL);
  if (required < 4 || required > DEVILUDO_MAX_PATH_CHARS) return 0;
  canonical = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, required * sizeof(wchar_t));
  if (canonical == NULL) return 0;
  if (GetFullPathNameW(value, required, canonical, &file_part) == 0 || file_part == NULL
    || _wcsicmp(canonical, value) != 0 || _wcsicmp(file_part, expected_file) != 0) goto cleanup;
  valid = 1;
cleanup:
  secure_free(canonical, required * sizeof(wchar_t));
  return valid;
}

static LONG load_configuration(const wchar_t *service_name, const wchar_t *expected_file, bridge_configuration *configuration) {
  wchar_t registry_path[512];
  HKEY key = NULL;
  DWORD contract = 0;
  DWORD contract_bytes = sizeof(contract);
  DWORD type = 0;
  LONG result;
  wchar_t *target_digest = NULL;
  wchar_t *descriptor_digest = NULL;
  if (_snwprintf_s(registry_path, sizeof(registry_path) / sizeof(registry_path[0]), _TRUNCATE,
    L"SYSTEM\\CurrentControlSet\\Services\\%ls\\Parameters", service_name) < 0) return ERROR_INVALID_DATA;
  result = RegOpenKeyExW(HKEY_LOCAL_MACHINE, registry_path, 0, KEY_QUERY_VALUE, &key);
  if (result != ERROR_SUCCESS) return result;
  result = RegGetValueW(key, NULL, L"BridgeContractVersion", RRF_RT_REG_DWORD, &type, &contract, &contract_bytes);
  if (result != ERROR_SUCCESS || contract != DEVILUDO_BRIDGE_CONTRACT_VERSION) { result = ERROR_REVISION_MISMATCH; goto cleanup; }
  result = read_registry_string(key, L"TargetExecutable", &configuration->target_executable, DEVILUDO_MAX_PATH_CHARS);
  if (result != ERROR_SUCCESS || !canonical_target_path(configuration->target_executable, expected_file)) {
    result = ERROR_INVALID_DATA; goto cleanup;
  }
  result = read_registry_string(key, L"TargetDigest", &target_digest, DEVILUDO_HASH_HEX_CHARS + 1);
  if (result != ERROR_SUCCESS || !lowercase_hex_digest(target_digest)) { result = ERROR_INVALID_DATA; goto cleanup; }
  result = read_registry_string(key, L"DescriptorDigest", &descriptor_digest, DEVILUDO_HASH_HEX_CHARS + 1);
  if (result != ERROR_SUCCESS || !lowercase_hex_digest(descriptor_digest)) { result = ERROR_INVALID_DATA; goto cleanup; }
  wmemcpy(configuration->target_digest, target_digest, DEVILUDO_HASH_HEX_CHARS + 1);
  wmemcpy(configuration->descriptor_digest, descriptor_digest, DEVILUDO_HASH_HEX_CHARS + 1);
  result = read_registry_environment(key, &configuration->environment, &configuration->environment_bytes);
cleanup:
  secure_free(target_digest, target_digest == NULL ? 0 : (wcslen(target_digest) + 1) * sizeof(wchar_t));
  secure_free(descriptor_digest, descriptor_digest == NULL ? 0 : (wcslen(descriptor_digest) + 1) * sizeof(wchar_t));
  if (key != NULL) RegCloseKey(key);
  return result;
}

static int digest_to_hex(const UCHAR *digest, wchar_t *output) {
  static const wchar_t hex[] = L"0123456789abcdef";
  DWORD index;
  for (index = 0; index < DEVILUDO_HASH_BYTES; index++) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  output[DEVILUDO_HASH_HEX_CHARS] = L'\0';
  return 1;
}

static int same_file_identity(const BY_HANDLE_FILE_INFORMATION *left, const BY_HANDLE_FILE_INFORMATION *right) {
  return left->dwVolumeSerialNumber == right->dwVolumeSerialNumber
    && left->nFileIndexHigh == right->nFileIndexHigh && left->nFileIndexLow == right->nFileIndexLow
    && left->nFileSizeHigh == right->nFileSizeHigh && left->nFileSizeLow == right->nFileSizeLow
    && CompareFileTime(&left->ftLastWriteTime, &right->ftLastWriteTime) == 0;
}

static DWORD verify_target_digest(
  const wchar_t *path,
  const wchar_t *expected_digest,
  HANDLE *verified_file,
  wchar_t **verified_path
) {
  HANDLE file = INVALID_HANDLE_VALUE;
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BY_HANDLE_FILE_INFORMATION before;
  BY_HANDLE_FILE_INFORMATION after;
  LARGE_INTEGER size;
  DWORD object_bytes = 0;
  DWORD result_bytes = 0;
  DWORD bytes_read = 0;
  DWORD status = ERROR_INVALID_DATA;
  PUCHAR hash_object = NULL;
  PUCHAR buffer = NULL;
  UCHAR digest[DEVILUDO_HASH_BYTES];
  wchar_t observed_digest[DEVILUDO_HASH_HEX_CHARS + 1];
  DWORD final_path_capacity = 0;
  DWORD final_path_chars = 0;
  wchar_t *final_path = NULL;
  if (verified_file == NULL || verified_path == NULL) return ERROR_INVALID_PARAMETER;
  *verified_file = INVALID_HANDLE_VALUE;
  *verified_path = NULL;
  file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  if (!GetFileInformationByHandle(file, &before) || !GetFileSizeEx(file, &size)
    || (before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    || size.QuadPart < 1 || (ULONGLONG) size.QuadPart > DEVILUDO_MAX_TARGET_BYTES) goto cleanup;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0
    || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR) &object_bytes, sizeof(object_bytes), &result_bytes, 0) < 0
    || object_bytes < 1 || object_bytes > 1024 * 1024) goto cleanup;
  hash_object = (PUCHAR) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, object_bytes);
  buffer = (PUCHAR) HeapAlloc(GetProcessHeap(), 0, 1024 * 1024);
  if (hash_object == NULL || buffer == NULL
    || BCryptCreateHash(algorithm, &hash, hash_object, object_bytes, NULL, 0, 0) < 0) goto cleanup;
  for (;;) {
    if (!ReadFile(file, buffer, 1024 * 1024, &bytes_read, NULL)) goto cleanup;
    if (bytes_read == 0) break;
    if (BCryptHashData(hash, buffer, bytes_read, 0) < 0) goto cleanup;
  }
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0
    || !GetFileInformationByHandle(file, &after) || !same_file_identity(&before, &after)) goto cleanup;
  digest_to_hex(digest, observed_digest);
  status = _wcsicmp(observed_digest, expected_digest) == 0 ? ERROR_SUCCESS : ERROR_CRC;
  if (status == ERROR_SUCCESS) {
    final_path_capacity = GetFinalPathNameByHandleW(file, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (final_path_capacity < 5 || final_path_capacity > DEVILUDO_MAX_PATH_CHARS) {
      status = ERROR_INVALID_NAME;
      goto cleanup;
    }
    final_path = (wchar_t *) HeapAlloc(
      GetProcessHeap(), HEAP_ZERO_MEMORY, final_path_capacity * sizeof(wchar_t));
    if (final_path == NULL) {
      status = ERROR_NOT_ENOUGH_MEMORY;
      goto cleanup;
    }
    final_path_chars = GetFinalPathNameByHandleW(file, final_path, final_path_capacity,
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (final_path_chars < 4 || final_path_chars >= final_path_capacity) {
      status = ERROR_INVALID_NAME;
      goto cleanup;
    }
    *verified_file = file;
    *verified_path = final_path;
    file = INVALID_HANDLE_VALUE;
    final_path = NULL;
  }
cleanup:
  SecureZeroMemory(digest, sizeof(digest));
  SecureZeroMemory(observed_digest, sizeof(observed_digest));
  secure_free(buffer, buffer == NULL ? 0 : 1024 * 1024);
  secure_free(hash_object, hash_object == NULL ? 0 : object_bytes);
  if (hash != NULL) BCryptDestroyHash(hash);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  secure_free(final_path, final_path == NULL ? 0 : final_path_capacity * sizeof(wchar_t));
  return status;
}

static DWORD create_target_process(const bridge_configuration *configuration, const wchar_t *verified_executable) {
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  wchar_t *command_line = NULL;
  wchar_t *working_directory = NULL;
  wchar_t *separator;
  SIZE_T path_chars;
  DWORD result = ERROR_INVALID_DATA;
  if (verified_executable == NULL) return ERROR_INVALID_PARAMETER;
  path_chars = wcslen(verified_executable);
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  ZeroMemory(&limits, sizeof(limits));
  startup.cb = sizeof(startup);
  command_line = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (path_chars + 3) * sizeof(wchar_t));
  working_directory = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (path_chars + 1) * sizeof(wchar_t));
  if (command_line == NULL || working_directory == NULL) { result = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }
  if (_snwprintf_s(command_line, path_chars + 3, _TRUNCATE, L"\"%ls\"", verified_executable) < 0) goto cleanup;
  wcscpy_s(working_directory, path_chars + 1, verified_executable);
  separator = wcsrchr(working_directory, L'\\');
  if (separator == NULL || separator == working_directory + 2) goto cleanup;
  *separator = L'\0';
  child_job = CreateJobObjectW(NULL, NULL);
  if (child_job == NULL) { result = GetLastError(); goto cleanup; }
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(child_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    result = GetLastError(); goto cleanup;
  }
  if (!CreateProcessW(verified_executable, command_line, NULL, NULL, FALSE,
    CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
    configuration->environment, working_directory, &startup, &process)) {
    result = GetLastError(); goto cleanup;
  }
  if (!AssignProcessToJobObject(child_job, process.hProcess) || ResumeThread(process.hThread) == (DWORD) -1) {
    result = GetLastError();
    TerminateProcess(process.hProcess, ERROR_PROCESS_ABORTED);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    goto cleanup;
  }
  CloseHandle(process.hThread);
  child_process = process.hProcess;
  result = ERROR_SUCCESS;
cleanup:
  secure_free(command_line, command_line == NULL ? 0 : (path_chars + 3) * sizeof(wchar_t));
  secure_free(working_directory, working_directory == NULL ? 0 : (path_chars + 1) * sizeof(wchar_t));
  return result;
}

static void free_configuration(bridge_configuration *configuration) {
  if (configuration == NULL) return;
  secure_free(configuration->target_executable,
    configuration->target_executable == NULL ? 0 : (wcslen(configuration->target_executable) + 1) * sizeof(wchar_t));
  secure_free(configuration->environment, configuration->environment_bytes + sizeof(wchar_t) * 2);
  SecureZeroMemory(configuration, sizeof(*configuration));
}

static VOID WINAPI service_main(DWORD argc, LPWSTR *argv) {
  const wchar_t *expected_file = NULL;
  bridge_configuration configuration;
  HANDLE waits[2];
  DWORD status;
  DWORD wait_result;
  DWORD child_exit = ERROR_PROCESS_ABORTED;
  HANDLE verified_target = INVALID_HANDLE_VALUE;
  wchar_t *verified_executable = NULL;
  ZeroMemory(&configuration, sizeof(configuration));
  if (argc < 1 || !is_allowed_service(argv[0], &expected_file)) return;
  service_status_handle = RegisterServiceCtrlHandlerExW(argv[0], service_control, NULL);
  if (service_status_handle == NULL) return;
  report_status(SERVICE_START_PENDING, NO_ERROR, 30000);
  stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (stop_event == NULL) { report_status(SERVICE_STOPPED, GetLastError(), 0); return; }
  status = load_configuration(argv[0], expected_file, &configuration);
  if (status == ERROR_SUCCESS) {
    status = verify_target_digest(configuration.target_executable, configuration.target_digest,
      &verified_target, &verified_executable);
  }
  if (status == ERROR_SUCCESS) status = create_target_process(&configuration, verified_executable);
  if (verified_target != INVALID_HANDLE_VALUE) {
    CloseHandle(verified_target);
    verified_target = INVALID_HANDLE_VALUE;
  }
  secure_free(verified_executable,
    verified_executable == NULL ? 0 : (wcslen(verified_executable) + 1) * sizeof(wchar_t));
  verified_executable = NULL;
  if (status != ERROR_SUCCESS) {
    free_configuration(&configuration);
    report_status(SERVICE_STOPPED, status, 0);
    CloseHandle(stop_event);
    stop_event = NULL;
    return;
  }
  report_status(SERVICE_RUNNING, NO_ERROR, 0);
  waits[0] = stop_event;
  waits[1] = child_process;
  wait_result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  if (wait_result == WAIT_OBJECT_0 && child_job != NULL) {
    TerminateJobObject(child_job, ERROR_PROCESS_ABORTED);
    WaitForSingleObject(child_process, 15000);
  }
  if (child_process != NULL) GetExitCodeProcess(child_process, &child_exit);
  if (child_process != NULL) CloseHandle(child_process);
  if (child_job != NULL) CloseHandle(child_job);
  if (stop_event != NULL) CloseHandle(stop_event);
  child_process = NULL;
  child_job = NULL;
  stop_event = NULL;
  free_configuration(&configuration);
  report_status(SERVICE_STOPPED,
    wait_result == WAIT_OBJECT_0 ? NO_ERROR : (child_exit == 0 ? NO_ERROR : ERROR_SERVICE_SPECIFIC_ERROR), 0);
}

static int write_identity(void) {
#if defined(_M_ARM64) || defined(__aarch64__)
  static const char identity[] = "{\"schemaVersion\":\"deviludo.windows-scm-service-bridge-identity.v1\",\"component\":\"deviludo-windows-scm-service-bridge\",\"version\":\"1.0.0\",\"contractVersion\":1,\"platform\":\"windows\",\"architecture\":\"arm64\"}\n";
#elif defined(_M_X64) || defined(__x86_64__)
  static const char identity[] = "{\"schemaVersion\":\"deviludo.windows-scm-service-bridge-identity.v1\",\"component\":\"deviludo-windows-scm-service-bridge\",\"version\":\"1.0.0\",\"contractVersion\":1,\"platform\":\"windows\",\"architecture\":\"x86_64\"}\n";
#else
#error Unsupported Windows SCM bridge architecture
#endif
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  return output != INVALID_HANDLE_VALUE
    && WriteFile(output, identity, (DWORD) (sizeof(identity) - 1), &written, NULL)
    && written == sizeof(identity) - 1 ? 0 : 1;
}

int wmain(int argc, wchar_t **argv) {
  SERVICE_TABLE_ENTRYW dispatch_table[] = {
    { L"", service_main },
    { NULL, NULL }
  };
  if (argc == 2 && wcscmp(argv[1], L"--identity") == 0) return write_identity();
  if (argc != 1) return ERROR_INVALID_PARAMETER;
  if (!StartServiceCtrlDispatcherW(dispatch_table)) return (int) GetLastError();
  return 0;
}
