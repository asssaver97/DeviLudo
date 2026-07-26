#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <accctrl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")

#define REQUEST_CONTRACT_VERSION 1UL
#define MAX_REQUEST_BYTES (256UL * 1024UL)
#define MAX_BINARY_BYTES (512ULL * 1024ULL * 1024ULL)
#define MAX_PATH_CHARS 32767UL
#define MAX_ENVIRONMENT_ENTRIES 128U
#define MAX_ENVIRONMENT_VALUE_CHARS 8192U
#define DIGEST_BYTES 32U
#define DIGEST_HEX_CHARS 64U

static const unsigned char REQUEST_MAGIC[16] = {
  'D', 'E', 'V', 'I', 'L', 'U', 'D', 'O', '_', 'S', 'C', 'M', '_', 'V', '1', 0
};
static const wchar_t *ACTUATOR_DIRECTORY = L"DeviLudo\\NativeActuator";
static const wchar_t *REQUEST_FILE = L"actuation-request.v1.bin";
static const wchar_t *ACTIVE_FILE = L"active-request.v1.bin";
static const wchar_t *ACTIVE_TEMP_FILE = L"active-request.v1.tmp";
static const wchar_t *PENDING_FILE = L"pending-request.v1.bin";
static const wchar_t *ACTUATOR_MUTEX = L"Global\\DeviLudoWindowsScmNativeActuatorV1";
static const wchar_t *BRIDGE_FILE = L"deviludo-windows-scm-service-bridge.exe";
static const wchar_t *PHYSICAL_FILE = L"deviludo-physical-runner.exe";
static const wchar_t *CONNECTOR_FILE = L"deviludo-steam-client-connector.exe";
static const wchar_t *FINALIZER_RUNTIME_FILE = L"node.exe";
static const wchar_t *FINALIZER_ARTIFACT_FILE = L"deviludo-steam-depot-finalizer-service.mjs";
static const wchar_t *PHYSICAL_SERVICE = L"DeviLudoPhysicalRunner";
static const wchar_t *CONNECTOR_SERVICE = L"DeviLudoSteamConnector";
static const wchar_t *FINALIZER_SERVICE = L"DeviLudoSteamDepotFinalizer";
static const wchar_t *PHYSICAL_ACCOUNT = L"NT SERVICE\\DeviLudoPhysicalRunner";
static const wchar_t *CONNECTOR_ACCOUNT = L"NT SERVICE\\DeviLudoSteamConnector";
static const wchar_t *FINALIZER_ACCOUNT = L"NT SERVICE\\DeviLudoSteamDepotFinalizer";

typedef struct request_cursor {
  const unsigned char *data;
  size_t length;
  size_t offset;
} request_cursor;

typedef struct service_request {
  unsigned char component;
  const wchar_t *service_name;
  const wchar_t *account;
  const wchar_t *expected_file;
  wchar_t *target_path;
  wchar_t *target_argument;
  wchar_t *target_argument_digest;
  wchar_t *working_directory;
  unsigned char target_digest[DIGEST_BYTES];
  unsigned char descriptor_digest[DIGEST_BYTES];
  wchar_t *environment;
  DWORD environment_bytes;
  HANDLE verified_target;
} service_request;

typedef struct actuation_request {
  unsigned char transaction_digest[DIGEST_BYTES];
  wchar_t *bridge_path;
  unsigned char bridge_digest[DIGEST_BYTES];
  unsigned char service_count;
  service_request services[2];
  HANDLE verified_bridge;
  unsigned char *raw;
  DWORD raw_bytes;
} actuation_request;

static void secure_free(void *value, SIZE_T bytes) {
  if (value != NULL) {
    SecureZeroMemory(value, bytes);
    HeapFree(GetProcessHeap(), 0, value);
  }
}

static int broad_sid_can_write(PACL dacl, PSID sid, DWORD dangerous) {
  TRUSTEE_W trustee;
  ACCESS_MASK rights = 0;
  ZeroMemory(&trustee, sizeof(trustee));
  BuildTrusteeWithSidW(&trustee, sid);
  return GetEffectiveRightsFromAclW(dacl, &trustee, &rights) != ERROR_SUCCESS || (rights & dangerous) != 0;
}

static int trusted_request_acl(HANDLE file) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  unsigned char system_sid[SECURITY_MAX_SID_SIZE];
  unsigned char administrators_sid[SECURITY_MAX_SID_SIZE];
  unsigned char world_sid[SECURITY_MAX_SID_SIZE];
  unsigned char authenticated_sid[SECURITY_MAX_SID_SIZE];
  unsigned char users_sid[SECURITY_MAX_SID_SIZE];
  DWORD system_bytes = sizeof(system_sid);
  DWORD administrators_bytes = sizeof(administrators_sid);
  DWORD world_bytes = sizeof(world_sid);
  DWORD authenticated_bytes = sizeof(authenticated_sid);
  DWORD users_bytes = sizeof(users_sid);
  int valid = 0;
  const DWORD dangerous = GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA
    | WRITE_DAC | WRITE_OWNER | DELETE;
  if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &dacl, NULL, &descriptor) != ERROR_SUCCESS || descriptor == NULL || owner == NULL
    || dacl == NULL || !IsValidAcl(dacl)) goto cleanup;
  if (!CreateWellKnownSid(WinLocalSystemSid, NULL, system_sid, &system_bytes)
    || !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators_sid, &administrators_bytes)
    || !CreateWellKnownSid(WinWorldSid, NULL, world_sid, &world_bytes)
    || !CreateWellKnownSid(WinAuthenticatedUserSid, NULL, authenticated_sid, &authenticated_bytes)
    || !CreateWellKnownSid(WinBuiltinUsersSid, NULL, users_sid, &users_bytes)
    || (!EqualSid(owner, system_sid) && !EqualSid(owner, administrators_sid))) goto cleanup;
  if (broad_sid_can_write(dacl, world_sid, dangerous)
    || broad_sid_can_write(dacl, authenticated_sid, dangerous)
    || broad_sid_can_write(dacl, users_sid, dangerous)) goto cleanup;
  valid = 1;
cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  return valid;
}

static int read_u8(request_cursor *cursor, unsigned char *value) {
  if (cursor->offset >= cursor->length) return 0;
  *value = cursor->data[cursor->offset++];
  return 1;
}

static int read_u16(request_cursor *cursor, uint16_t *value) {
  if (cursor->offset + 2 > cursor->length) return 0;
  *value = (uint16_t) cursor->data[cursor->offset]
    | ((uint16_t) cursor->data[cursor->offset + 1] << 8);
  cursor->offset += 2;
  return 1;
}

static int read_u32(request_cursor *cursor, uint32_t *value) {
  if (cursor->offset + 4 > cursor->length) return 0;
  *value = (uint32_t) cursor->data[cursor->offset]
    | ((uint32_t) cursor->data[cursor->offset + 1] << 8)
    | ((uint32_t) cursor->data[cursor->offset + 2] << 16)
    | ((uint32_t) cursor->data[cursor->offset + 3] << 24);
  cursor->offset += 4;
  return 1;
}

static int read_bytes(request_cursor *cursor, void *output, size_t bytes) {
  if (bytes > cursor->length || cursor->offset > cursor->length - bytes) return 0;
  memcpy(output, cursor->data + cursor->offset, bytes);
  cursor->offset += bytes;
  return 1;
}

static int valid_utf16(const wchar_t *value, size_t chars, int allow_empty) {
  size_t index;
  if ((!allow_empty && chars == 0) || value == NULL) return 0;
  for (index = 0; index < chars; index++) {
    uint16_t character = (uint16_t) value[index];
    if (character == 0 || character == L'\r' || character == L'\n') return 0;
    if (character >= 0xd800U && character <= 0xdbffU) {
      if (++index >= chars || (uint16_t) value[index] < 0xdc00U || (uint16_t) value[index] > 0xdfffU) return 0;
    } else if (character >= 0xdc00U && character <= 0xdfffU) return 0;
  }
  return 1;
}

static wchar_t *read_utf16(request_cursor *cursor, uint16_t chars, uint16_t maximum, int allow_empty) {
  size_t bytes = (size_t) chars * sizeof(wchar_t);
  wchar_t *value;
  if (chars > maximum || (!allow_empty && chars == 0) || cursor->offset > cursor->length
    || bytes > cursor->length - cursor->offset) return NULL;
  value = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes + sizeof(wchar_t));
  if (value == NULL) return NULL;
  memcpy(value, cursor->data + cursor->offset, bytes);
  cursor->offset += bytes;
  if (!valid_utf16(value, chars, allow_empty)) {
    secure_free(value, bytes + sizeof(wchar_t));
    return NULL;
  }
  value[chars] = L'\0';
  return value;
}

static int path_has_invalid_character(const wchar_t *value) {
  const wchar_t *cursor;
  for (cursor = value + 3; *cursor != L'\0'; cursor++) {
    if (*cursor == L'/' || *cursor == L':' || *cursor == L'*' || *cursor == L'?'
      || *cursor == L'"' || *cursor == L'<' || *cursor == L'>' || *cursor == L'|') return 1;
  }
  return 0;
}

static int canonical_path(const wchar_t *value, const wchar_t *expected_file) {
  wchar_t *canonical = NULL;
  wchar_t *file_part = NULL;
  const wchar_t *segment;
  DWORD required;
  int valid = 0;
  size_t length;
  if (value == NULL || expected_file == NULL) return 0;
  length = wcslen(value);
  if (length < 4 || length >= MAX_PATH_CHARS || value[1] != L':' || value[2] != L'\\'
    || path_has_invalid_character(value)) return 0;
  segment = value + 3;
  while (*segment != L'\0') {
    const wchar_t *end = wcschr(segment, L'\\');
    size_t segment_length = end == NULL ? wcslen(segment) : (size_t) (end - segment);
    if (segment_length == 0 || (segment_length == 1 && segment[0] == L'.')
      || (segment_length == 2 && segment[0] == L'.' && segment[1] == L'.')) return 0;
    if (end == NULL) break;
    segment = end + 1;
  }
  required = GetFullPathNameW(value, 0, NULL, NULL);
  if (required < 4 || required > MAX_PATH_CHARS) return 0;
  canonical = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, required * sizeof(wchar_t));
  if (canonical == NULL) return 0;
  if (GetFullPathNameW(value, required, canonical, &file_part) != 0 && file_part != NULL
    && _wcsicmp(canonical, value) == 0 && _wcsicmp(file_part, expected_file) == 0) valid = 1;
  secure_free(canonical, required * sizeof(wchar_t));
  return valid;
}

static int safe_environment_name(const char *name, size_t length) {
  size_t index;
  if (length < 1 || length > 255 || name[0] < 'A' || name[0] > 'Z') return 0;
  for (index = 1; index < length; index++) {
    char character = name[index];
    if (!((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')
      || character == '_')) return 0;
  }
  return 1;
}

static int ends_with(const char *name, size_t length, const char *suffix) {
  size_t suffix_length = strlen(suffix);
  return length >= suffix_length && memcmp(name + length - suffix_length, suffix, suffix_length) == 0;
}

static int inline_credential_name(const char *name, size_t length) {
  static const char *blocked[] = { "API_KEY", "PASSWORD", "TOKEN", "SECRET", "SESSION", "PRIVATE_KEY" };
  size_t index;
  for (index = 0; index < sizeof(blocked) / sizeof(blocked[0]); index++) {
    if (ends_with(name, length, blocked[index])) return 1;
  }
  return 0;
}

static int append_environment_entry(
  wchar_t **environment,
  size_t *used_chars,
  size_t *capacity_chars,
  const char *name,
  size_t name_chars,
  const wchar_t *value,
  size_t value_chars
) {
  size_t required = *used_chars + name_chars + 1 + value_chars + 1 + 1;
  wchar_t *resized;
  size_t index;
  if (required > (MAX_REQUEST_BYTES / sizeof(wchar_t))) return 0;
  if (required > *capacity_chars) {
    size_t next = *capacity_chars == 0 ? 256 : *capacity_chars;
    while (next < required) next *= 2;
    resized = *environment == NULL
      ? (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, next * sizeof(wchar_t))
      : (wchar_t *) HeapReAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, *environment, next * sizeof(wchar_t));
    if (resized == NULL) return 0;
    *environment = resized;
    *capacity_chars = next;
  }
  for (index = 0; index < name_chars; index++) (*environment)[(*used_chars)++] = (wchar_t) name[index];
  (*environment)[(*used_chars)++] = L'=';
  if (value_chars > 0) {
    wmemcpy(*environment + *used_chars, value, value_chars);
    *used_chars += value_chars;
  }
  (*environment)[(*used_chars)++] = L'\0';
  (*environment)[*used_chars] = L'\0';
  return 1;
}

static void free_service_request(service_request *service) {
  if (service == NULL) return;
  if (service->verified_target != NULL && service->verified_target != INVALID_HANDLE_VALUE) CloseHandle(service->verified_target);
  secure_free(service->target_path,
    service->target_path == NULL ? 0 : (wcslen(service->target_path) + 1) * sizeof(wchar_t));
  secure_free(service->target_argument,
    service->target_argument == NULL ? 0 : (wcslen(service->target_argument) + 1) * sizeof(wchar_t));
  secure_free(service->target_argument_digest,
    service->target_argument_digest == NULL ? 0 : (wcslen(service->target_argument_digest) + 1) * sizeof(wchar_t));
  secure_free(service->working_directory,
    service->working_directory == NULL ? 0 : (wcslen(service->working_directory) + 1) * sizeof(wchar_t));
  secure_free(service->environment, service->environment_bytes);
  SecureZeroMemory(service, sizeof(*service));
}

static void free_actuation_request(actuation_request *request) {
  unsigned char index;
  if (request == NULL) return;
  if (request->verified_bridge != NULL && request->verified_bridge != INVALID_HANDLE_VALUE) CloseHandle(request->verified_bridge);
  for (index = 0; index < request->service_count && index < 2; index++) free_service_request(&request->services[index]);
  secure_free(request->bridge_path,
    request->bridge_path == NULL ? 0 : (wcslen(request->bridge_path) + 1) * sizeof(wchar_t));
  secure_free(request->raw, request->raw_bytes);
  SecureZeroMemory(request, sizeof(*request));
}

static int initialize_component(service_request *service, unsigned char component) {
  service->component = component;
  service->verified_target = INVALID_HANDLE_VALUE;
  if (component == 1) {
    service->service_name = PHYSICAL_SERVICE;
    service->account = PHYSICAL_ACCOUNT;
    service->expected_file = PHYSICAL_FILE;
    return 1;
  }
  if (component == 2) {
    service->service_name = CONNECTOR_SERVICE;
    service->account = CONNECTOR_ACCOUNT;
    service->expected_file = CONNECTOR_FILE;
    return 1;
  }
  if (component == 3) {
    service->service_name = FINALIZER_SERVICE;
    service->account = FINALIZER_ACCOUNT;
    service->expected_file = FINALIZER_RUNTIME_FILE;
    return 1;
  }
  return 0;
}

static wchar_t *duplicate_wide(const wchar_t *value, size_t chars) {
  wchar_t *copy;
  if (value == NULL || chars > MAX_PATH_CHARS) return NULL;
  copy = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (chars + 1) * sizeof(wchar_t));
  if (copy != NULL) wmemcpy(copy, value, chars);
  return copy;
}

static int lowercase_hex_wide(const wchar_t *value) {
  size_t index;
  if (value == NULL || wcslen(value) != DIGEST_HEX_CHARS) return 0;
  for (index = 0; index < DIGEST_HEX_CHARS; index++) {
    if (!((value[index] >= L'0' && value[index] <= L'9')
      || (value[index] >= L'a' && value[index] <= L'f'))) return 0;
  }
  return 1;
}

static int parse_service(request_cursor *cursor, service_request *service) {
  unsigned char component;
  uint16_t path_chars;
  uint16_t environment_count;
  uint16_t environment_index;
  wchar_t *environment = NULL;
  size_t environment_chars = 0;
  size_t environment_capacity = 0;
  char previous_name[256] = { 0 };
  if (!read_u8(cursor, &component) || !initialize_component(service, component)
    || !read_bytes(cursor, service->target_digest, DIGEST_BYTES)
    || !read_bytes(cursor, service->descriptor_digest, DIGEST_BYTES)
    || !read_u16(cursor, &path_chars) || !read_u16(cursor, &environment_count)
    || environment_count < 2 || environment_count > MAX_ENVIRONMENT_ENTRIES) return 0;
  service->target_path = read_utf16(cursor, path_chars, (uint16_t) (MAX_PATH_CHARS - 1), 0);
  if (service->target_path == NULL || !canonical_path(service->target_path, service->expected_file)) return 0;
  for (environment_index = 0; environment_index < environment_count; environment_index++) {
    unsigned char name_length;
    uint16_t value_length;
    char name[256] = { 0 };
    wchar_t *value;
    if (!read_u8(cursor, &name_length) || !read_u16(cursor, &value_length)
      || name_length < 1 || value_length > MAX_ENVIRONMENT_VALUE_CHARS
      || !read_bytes(cursor, name, name_length) || !safe_environment_name(name, name_length)
      || inline_credential_name(name, name_length)
      || (previous_name[0] != 0 && strcmp(previous_name, name) >= 0)) return 0;
    value = read_utf16(cursor, value_length, MAX_ENVIRONMENT_VALUE_CHARS, 1);
    if (value == NULL) return 0;
    if (!append_environment_entry(&environment, &environment_chars, &environment_capacity,
      name, name_length, value, value_length)) {
      secure_free(value, ((size_t) value_length + 1) * sizeof(wchar_t));
      service->environment = environment;
      service->environment_bytes = (DWORD) (environment_capacity * sizeof(wchar_t));
      return 0;
    }
    service->environment = environment;
    service->environment_bytes = (DWORD) (environment_capacity * sizeof(wchar_t));
    if (service->component == 3
      && strcmp(name, "DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE") == 0) {
      if (service->target_argument != NULL || value_length < 4
        || (service->target_argument = duplicate_wide(value, value_length)) == NULL) {
        secure_free(value, ((size_t) value_length + 1) * sizeof(wchar_t));
        return 0;
      }
    }
    if (service->component == 3
      && strcmp(name, "DEVILUDO_STEAM_DEPOT_FINALIZER_BINARY_DIGEST") == 0) {
      if (service->target_argument_digest != NULL || value_length != DIGEST_HEX_CHARS
        || !lowercase_hex_wide(value)
        || (service->target_argument_digest = duplicate_wide(value, value_length)) == NULL) {
        secure_free(value, ((size_t) value_length + 1) * sizeof(wchar_t));
        return 0;
      }
    }
    strcpy_s(previous_name, sizeof(previous_name), name);
    secure_free(value, ((size_t) value_length + 1) * sizeof(wchar_t));
  }
  service->environment = environment;
  service->environment_bytes = (DWORD) ((environment_chars + 1) * sizeof(wchar_t));
  if (service->component == 3) {
    wchar_t *separator;
    size_t argument_chars;
    if (service->target_argument == NULL || service->target_argument_digest == NULL
      || !canonical_path(service->target_argument, FINALIZER_ARTIFACT_FILE)) return 0;
    argument_chars = wcslen(service->target_argument);
    service->working_directory = duplicate_wide(service->target_argument, argument_chars);
    if (service->working_directory == NULL) return 0;
    separator = wcsrchr(service->working_directory, L'\\');
    if (separator == NULL || separator <= service->working_directory + 2) return 0;
    *separator = L'\0';
  }
  return 1;
}

static int parse_request(unsigned char *bytes, DWORD byte_count, actuation_request *request) {
  request_cursor cursor;
  uint32_t version;
  uint32_t total_length;
  uint16_t bridge_path_chars;
  unsigned char reserved;
  unsigned char index;
  ZeroMemory(request, sizeof(*request));
  request->verified_bridge = INVALID_HANDLE_VALUE;
  request->raw = bytes;
  request->raw_bytes = byte_count;
  cursor.data = bytes;
  cursor.length = byte_count;
  cursor.offset = 0;
  if (byte_count < 128 || byte_count > MAX_REQUEST_BYTES
    || !read_bytes(&cursor, request->transaction_digest, sizeof(REQUEST_MAGIC))
    || memcmp(request->transaction_digest, REQUEST_MAGIC, sizeof(REQUEST_MAGIC)) != 0
    || !read_u32(&cursor, &version) || version != REQUEST_CONTRACT_VERSION
    || !read_u32(&cursor, &total_length) || total_length != byte_count
    || !read_bytes(&cursor, request->transaction_digest, DIGEST_BYTES)
    || !read_bytes(&cursor, request->bridge_digest, DIGEST_BYTES)
    || !read_u16(&cursor, &bridge_path_chars)
    || !read_u8(&cursor, &request->service_count) || !read_u8(&cursor, &reserved)
    || reserved != 0 || (request->service_count != 1 && request->service_count != 2)) return 0;
  request->bridge_path = read_utf16(&cursor, bridge_path_chars, (uint16_t) (MAX_PATH_CHARS - 1), 0);
  if (request->bridge_path == NULL || !canonical_path(request->bridge_path, BRIDGE_FILE)) return 0;
  for (index = 0; index < request->service_count; index++) {
    if (!parse_service(&cursor, &request->services[index])) return 0;
  }
  if (cursor.offset != cursor.length) return 0;
  if ((request->service_count == 1
      && request->services[0].component != 1 && request->services[0].component != 3)
    || (request->service_count == 2
      && (request->services[0].component != 2 || request->services[1].component != 1))) return 0;
  return 1;
}

static DWORD read_fixed_file(const wchar_t *path, unsigned char **bytes, DWORD *byte_count, int allow_missing) {
  HANDLE file = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION information;
  LARGE_INTEGER size;
  unsigned char *body = NULL;
  DWORD total = 0;
  DWORD result = ERROR_INVALID_DATA;
  *bytes = NULL;
  *byte_count = 0;
  file = CreateFileW(path, GENERIC_READ, 0, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    result = GetLastError();
    return allow_missing && result == ERROR_FILE_NOT_FOUND ? ERROR_FILE_NOT_FOUND : result;
  }
  if (!GetFileInformationByHandle(file, &information) || !GetFileSizeEx(file, &size)
    || (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    || size.QuadPart < 128 || size.QuadPart > MAX_REQUEST_BYTES || !trusted_request_acl(file)) goto cleanup;
  body = (unsigned char *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T) size.QuadPart);
  if (body == NULL) { result = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }
  while (total < (DWORD) size.QuadPart) {
    DWORD observed = 0;
    if (!ReadFile(file, body + total, (DWORD) size.QuadPart - total, &observed, NULL) || observed == 0) goto cleanup;
    total += observed;
  }
  *bytes = body;
  *byte_count = total;
  body = NULL;
  result = ERROR_SUCCESS;
cleanup:
  secure_free(body, body == NULL ? 0 : (SIZE_T) size.QuadPart);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  return result;
}

static DWORD sha256_file(const wchar_t *path, const unsigned char expected[DIGEST_BYTES], HANDLE *verified) {
  HANDLE file = INVALID_HANDLE_VALUE;
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BY_HANDLE_FILE_INFORMATION before;
  BY_HANDLE_FILE_INFORMATION after;
  LARGE_INTEGER size;
  DWORD object_bytes = 0;
  DWORD result_bytes = 0;
  DWORD bytes_read;
  DWORD result = ERROR_INVALID_DATA;
  PUCHAR hash_object = NULL;
  PUCHAR buffer = NULL;
  unsigned char digest[DIGEST_BYTES];
  *verified = INVALID_HANDLE_VALUE;
  file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  if (!GetFileInformationByHandle(file, &before) || !GetFileSizeEx(file, &size)
    || (before.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    || size.QuadPart < 1 || (ULONGLONG) size.QuadPart > MAX_BINARY_BYTES) goto cleanup;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0
    || BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR) &object_bytes,
      sizeof(object_bytes), &result_bytes, 0) < 0 || object_bytes < 1 || object_bytes > 1024 * 1024) goto cleanup;
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
    || !GetFileInformationByHandle(file, &after)
    || before.dwVolumeSerialNumber != after.dwVolumeSerialNumber
    || before.nFileIndexHigh != after.nFileIndexHigh || before.nFileIndexLow != after.nFileIndexLow
    || before.nFileSizeHigh != after.nFileSizeHigh || before.nFileSizeLow != after.nFileSizeLow
    || CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime) != 0
    || memcmp(digest, expected, DIGEST_BYTES) != 0) {
    result = ERROR_CRC;
    goto cleanup;
  }
  *verified = file;
  file = INVALID_HANDLE_VALUE;
  result = ERROR_SUCCESS;
cleanup:
  SecureZeroMemory(digest, sizeof(digest));
  secure_free(buffer, buffer == NULL ? 0 : 1024 * 1024);
  secure_free(hash_object, hash_object == NULL ? 0 : object_bytes);
  if (hash != NULL) BCryptDestroyHash(hash);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  return result;
}

static DWORD verify_binaries(actuation_request *request) {
  unsigned char index;
  DWORD result = sha256_file(request->bridge_path, request->bridge_digest, &request->verified_bridge);
  if (result != ERROR_SUCCESS) return result;
  for (index = 0; index < request->service_count; index++) {
    result = sha256_file(request->services[index].target_path, request->services[index].target_digest,
      &request->services[index].verified_target);
    if (result != ERROR_SUCCESS) return result;
  }
  return ERROR_SUCCESS;
}

static void digest_hex(const unsigned char digest[DIGEST_BYTES], wchar_t output[DIGEST_HEX_CHARS + 1]) {
  static const wchar_t hex[] = L"0123456789abcdef";
  unsigned int index;
  for (index = 0; index < DIGEST_BYTES; index++) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  output[DIGEST_HEX_CHARS] = L'\0';
}

static DWORD wait_service_state(SC_HANDLE service, DWORD desired, DWORD timeout_ms) {
  ULONGLONG deadline = GetTickCount64() + timeout_ms;
  SERVICE_STATUS_PROCESS status;
  DWORD needed;
  for (;;) {
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (LPBYTE) &status, sizeof(status), &needed)) return GetLastError();
    if (status.dwCurrentState == desired) return ERROR_SUCCESS;
    if (GetTickCount64() >= deadline || (desired == SERVICE_RUNNING && status.dwCurrentState == SERVICE_STOPPED)) {
      return ERROR_SERVICE_REQUEST_TIMEOUT;
    }
    Sleep(200);
  }
}

static DWORD stop_service(SC_HANDLE service) {
  SERVICE_STATUS_PROCESS status;
  SERVICE_STATUS control_status;
  DWORD needed;
  if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (LPBYTE) &status, sizeof(status), &needed)) return GetLastError();
  if (status.dwCurrentState == SERVICE_STOPPED) return ERROR_SUCCESS;
  if (!ControlService(service, SERVICE_CONTROL_STOP, &control_status) && GetLastError() != ERROR_SERVICE_NOT_ACTIVE) return GetLastError();
  return wait_service_state(service, SERVICE_STOPPED, 30000);
}

static DWORD write_service_parameters(const service_request *definition) {
  wchar_t path[512];
  wchar_t target_digest[DIGEST_HEX_CHARS + 1];
  wchar_t descriptor_digest[DIGEST_HEX_CHARS + 1];
  DWORD contract = REQUEST_CONTRACT_VERSION;
  HKEY key = NULL;
  LONG result;
  if (_snwprintf_s(path, sizeof(path) / sizeof(path[0]), _TRUNCATE,
    L"SYSTEM\\CurrentControlSet\\Services\\%ls\\Parameters", definition->service_name) < 0) return ERROR_INVALID_DATA;
  result = RegCreateKeyExW(HKEY_LOCAL_MACHINE, path, 0, NULL, REG_OPTION_NON_VOLATILE,
    KEY_SET_VALUE, NULL, &key, NULL);
  if (result != ERROR_SUCCESS) return (DWORD) result;
  digest_hex(definition->target_digest, target_digest);
  digest_hex(definition->descriptor_digest, descriptor_digest);
  result = RegSetValueExW(key, L"BridgeContractVersion", 0, REG_DWORD, (const BYTE *) &contract, sizeof(contract));
  if (result == ERROR_SUCCESS) result = RegSetValueExW(key, L"TargetExecutable", 0, REG_SZ,
    (const BYTE *) definition->target_path, (DWORD) ((wcslen(definition->target_path) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS) result = RegSetValueExW(key, L"TargetDigest", 0, REG_SZ,
    (const BYTE *) target_digest, sizeof(target_digest));
  if (result == ERROR_SUCCESS) result = RegSetValueExW(key, L"DescriptorDigest", 0, REG_SZ,
    (const BYTE *) descriptor_digest, sizeof(descriptor_digest));
  if (result == ERROR_SUCCESS) result = RegSetValueExW(key, L"Environment", 0, REG_MULTI_SZ,
    (const BYTE *) definition->environment, definition->environment_bytes);
  if (result == ERROR_SUCCESS && definition->component == 3) result = RegSetValueExW(key, L"TargetArgument", 0, REG_SZ,
    (const BYTE *) definition->target_argument,
    (DWORD) ((wcslen(definition->target_argument) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS && definition->component == 3) result = RegSetValueExW(key, L"TargetArgumentDigest", 0, REG_SZ,
    (const BYTE *) definition->target_argument_digest,
    (DWORD) ((wcslen(definition->target_argument_digest) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS && definition->component == 3) result = RegSetValueExW(key, L"WorkingDirectory", 0, REG_SZ,
    (const BYTE *) definition->working_directory,
    (DWORD) ((wcslen(definition->working_directory) + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return (DWORD) result;
}

static DWORD registry_value_equals(
  HKEY key,
  const wchar_t *name,
  DWORD flags,
  const void *expected,
  DWORD expected_bytes
) {
  DWORD type = 0;
  DWORD observed_bytes = 0;
  DWORD allocated_bytes;
  unsigned char *observed = NULL;
  LONG result = RegGetValueW(key, NULL, name, flags, &type, NULL, &observed_bytes);
  if (result != ERROR_SUCCESS || observed_bytes != expected_bytes) return ERROR_INVALID_DATA;
  allocated_bytes = observed_bytes;
  observed = (unsigned char *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, observed_bytes);
  if (observed == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  result = RegGetValueW(key, NULL, name, flags, &type, observed, &observed_bytes);
  if (result == ERROR_SUCCESS && memcmp(observed, expected, expected_bytes) != 0) result = ERROR_INVALID_DATA;
  secure_free(observed, allocated_bytes);
  return (DWORD) result;
}

static DWORD verify_service_parameters(const service_request *definition) {
  wchar_t path[512];
  wchar_t target_digest[DIGEST_HEX_CHARS + 1];
  wchar_t descriptor_digest[DIGEST_HEX_CHARS + 1];
  DWORD contract = REQUEST_CONTRACT_VERSION;
  HKEY key = NULL;
  DWORD result;
  if (_snwprintf_s(path, sizeof(path) / sizeof(path[0]), _TRUNCATE,
    L"SYSTEM\\CurrentControlSet\\Services\\%ls\\Parameters", definition->service_name) < 0) return ERROR_INVALID_DATA;
  result = (DWORD) RegOpenKeyExW(HKEY_LOCAL_MACHINE, path, 0, KEY_QUERY_VALUE, &key);
  if (result != ERROR_SUCCESS) return result;
  digest_hex(definition->target_digest, target_digest);
  digest_hex(definition->descriptor_digest, descriptor_digest);
  result = registry_value_equals(key, L"BridgeContractVersion", RRF_RT_REG_DWORD, &contract, sizeof(contract));
  if (result == ERROR_SUCCESS) result = registry_value_equals(key, L"TargetExecutable", RRF_RT_REG_SZ,
    definition->target_path, (DWORD) ((wcslen(definition->target_path) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS) result = registry_value_equals(key, L"TargetDigest", RRF_RT_REG_SZ,
    target_digest, sizeof(target_digest));
  if (result == ERROR_SUCCESS) result = registry_value_equals(key, L"DescriptorDigest", RRF_RT_REG_SZ,
    descriptor_digest, sizeof(descriptor_digest));
  if (result == ERROR_SUCCESS) result = registry_value_equals(key, L"Environment", RRF_RT_REG_MULTI_SZ,
    definition->environment, definition->environment_bytes);
  if (result == ERROR_SUCCESS && definition->component == 3) result = registry_value_equals(key, L"TargetArgument", RRF_RT_REG_SZ,
    definition->target_argument, (DWORD) ((wcslen(definition->target_argument) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS && definition->component == 3) result = registry_value_equals(key, L"TargetArgumentDigest", RRF_RT_REG_SZ,
    definition->target_argument_digest,
    (DWORD) ((wcslen(definition->target_argument_digest) + 1) * sizeof(wchar_t)));
  if (result == ERROR_SUCCESS && definition->component == 3) result = registry_value_equals(key, L"WorkingDirectory", RRF_RT_REG_SZ,
    definition->working_directory, (DWORD) ((wcslen(definition->working_directory) + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return result;
}

static DWORD configure_service(SC_HANDLE manager, const actuation_request *request, const service_request *definition) {
  SC_HANDLE service;
  wchar_t *quoted_bridge;
  size_t quoted_chars = wcslen(request->bridge_path) + 3;
  SERVICE_FAILURE_ACTIONSW failures;
  SERVICE_SID_INFO sid_information;
  SERVICE_REQUIRED_PRIVILEGES_INFOW privileges;
  wchar_t empty_privileges[2] = { L'\0', L'\0' };
  SC_ACTION action;
  DWORD result;
  quoted_bridge = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, quoted_chars * sizeof(wchar_t));
  if (quoted_bridge == NULL) return ERROR_NOT_ENOUGH_MEMORY;
  if (_snwprintf_s(quoted_bridge, quoted_chars, _TRUNCATE, L"\"%ls\"", request->bridge_path) < 0) {
    secure_free(quoted_bridge, quoted_chars * sizeof(wchar_t));
    return ERROR_INVALID_DATA;
  }
  service = OpenServiceW(manager, definition->service_name,
    SERVICE_CHANGE_CONFIG | SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP);
  if (service == NULL && GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST) {
    service = CreateServiceW(manager, definition->service_name, definition->service_name,
      SERVICE_CHANGE_CONFIG | SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP,
      SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, quoted_bridge,
      NULL, NULL, NULL, definition->account, NULL);
  }
  if (service == NULL) {
    result = GetLastError();
    secure_free(quoted_bridge, quoted_chars * sizeof(wchar_t));
    return result;
  }
  result = stop_service(service);
  if (result == ERROR_SUCCESS && !ChangeServiceConfigW(service, SERVICE_WIN32_OWN_PROCESS,
    SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, quoted_bridge, NULL, NULL, NULL, definition->account, NULL, NULL)) {
    result = GetLastError();
  }
  ZeroMemory(&failures, sizeof(failures));
  action.Type = SC_ACTION_RESTART;
  action.Delay = 5000;
  failures.dwResetPeriod = 86400;
  failures.cActions = 1;
  failures.lpsaActions = &action;
  if (result == ERROR_SUCCESS && !ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failures)) result = GetLastError();
  sid_information.dwServiceSidType = SERVICE_SID_TYPE_RESTRICTED;
  if (result == ERROR_SUCCESS && definition->component == 3
    && !ChangeServiceConfig2W(service, SERVICE_CONFIG_SERVICE_SID_INFO, &sid_information)) result = GetLastError();
  privileges.pmszRequiredPrivileges = empty_privileges;
  if (result == ERROR_SUCCESS && definition->component == 3
    && !ChangeServiceConfig2W(service, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, &privileges)) result = GetLastError();
  if (result == ERROR_SUCCESS) result = write_service_parameters(definition);
  CloseServiceHandle(service);
  secure_free(quoted_bridge, quoted_chars * sizeof(wchar_t));
  return result;
}

static DWORD remove_service(SC_HANDLE manager, const wchar_t *service_name) {
  SC_HANDLE service = OpenServiceW(manager, service_name, DELETE | SERVICE_STOP | SERVICE_QUERY_STATUS);
  DWORD result;
  wchar_t path[512];
  if (service == NULL && GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST) return ERROR_SUCCESS;
  if (service == NULL) return GetLastError();
  result = stop_service(service);
  if (result == ERROR_SUCCESS && !DeleteService(service) && GetLastError() != ERROR_SERVICE_MARKED_FOR_DELETE) result = GetLastError();
  CloseServiceHandle(service);
  if (result == ERROR_SUCCESS && _snwprintf_s(path, sizeof(path) / sizeof(path[0]), _TRUNCATE,
    L"SYSTEM\\CurrentControlSet\\Services\\%ls\\Parameters", service_name) >= 0) {
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, path);
  }
  return result;
}

static DWORD apply_services(const actuation_request *request) {
  SC_HANDLE manager = OpenSCManagerW(NULL, SERVICES_ACTIVE_DATABASE,
    SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE);
  unsigned char index;
  DWORD result = ERROR_SUCCESS;
  if (manager == NULL) return GetLastError();
  for (index = 0; index < request->service_count && result == ERROR_SUCCESS; index++) {
    result = configure_service(manager, request, &request->services[index]);
  }
  if (result == ERROR_SUCCESS && request->service_count == 1 && request->services[0].component == 1) {
    result = remove_service(manager, CONNECTOR_SERVICE);
  }
  for (index = 0; index < request->service_count && result == ERROR_SUCCESS; index++) {
    SC_HANDLE service = OpenServiceW(manager, request->services[index].service_name, SERVICE_START | SERVICE_QUERY_STATUS);
    if (service == NULL) { result = GetLastError(); break; }
    if (!StartServiceW(service, 0, NULL) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING) result = GetLastError();
    if (result == ERROR_SUCCESS) result = wait_service_state(service, SERVICE_RUNNING, 30000);
    CloseServiceHandle(service);
  }
  CloseServiceHandle(manager);
  return result;
}

static DWORD create_only_file(const wchar_t *path, const unsigned char *bytes, DWORD byte_count) {
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW,
    FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, NULL);
  DWORD written = 0;
  DWORD result;
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  result = WriteFile(file, bytes, byte_count, &written, NULL) && written == byte_count && FlushFileBuffers(file)
    ? ERROR_SUCCESS : GetLastError();
  CloseHandle(file);
  if (result != ERROR_SUCCESS) DeleteFileW(path);
  return result;
}

static DWORD replace_active_file(
  const wchar_t *temporary_path,
  const wchar_t *active_path,
  const unsigned char *bytes,
  DWORD byte_count
) {
  DWORD result;
  DeleteFileW(temporary_path);
  result = create_only_file(temporary_path, bytes, byte_count);
  if (result != ERROR_SUCCESS) return result;
  if (!MoveFileExW(temporary_path, active_path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    result = GetLastError();
    DeleteFileW(temporary_path);
    return result;
  }
  return ERROR_SUCCESS;
}

static DWORD load_request(const wchar_t *path, actuation_request *request, int allow_missing) {
  unsigned char *bytes = NULL;
  DWORD byte_count = 0;
  DWORD result = read_fixed_file(path, &bytes, &byte_count, allow_missing);
  if (result != ERROR_SUCCESS) return result;
  if (!parse_request(bytes, byte_count, request)) {
    free_actuation_request(request);
    return ERROR_INVALID_DATA;
  }
  result = verify_binaries(request);
  if (result != ERROR_SUCCESS) free_actuation_request(request);
  return result;
}

static DWORD restore_active(const wchar_t *active_path, const wchar_t *pending_path) {
  actuation_request previous;
  SC_HANDLE manager;
  DWORD result = load_request(active_path, &previous, 1);
  if (result == ERROR_FILE_NOT_FOUND) {
    actuation_request pending;
    unsigned char index;
    result = load_request(pending_path, &pending, 0);
    if (result != ERROR_SUCCESS) return result;
    manager = OpenSCManagerW(NULL, SERVICES_ACTIVE_DATABASE, SC_MANAGER_CONNECT);
    if (manager == NULL) { result = GetLastError(); free_actuation_request(&pending); return result; }
    for (index = 0; index < pending.service_count && result == ERROR_SUCCESS; index++) {
      result = remove_service(manager, pending.services[index].service_name);
    }
    CloseServiceHandle(manager);
    free_actuation_request(&pending);
  } else if (result == ERROR_SUCCESS) {
    result = apply_services(&previous);
    free_actuation_request(&previous);
  }
  if (result == ERROR_SUCCESS && !DeleteFileW(pending_path) && GetLastError() != ERROR_FILE_NOT_FOUND) return GetLastError();
  return result;
}

static DWORD apply_request(
  const wchar_t *request_path,
  const wchar_t *active_path,
  const wchar_t *temporary_path,
  const wchar_t *pending_path
) {
  actuation_request next;
  DWORD result;
  if (GetFileAttributesW(pending_path) != INVALID_FILE_ATTRIBUTES) {
    result = restore_active(active_path, pending_path);
    if (result != ERROR_SUCCESS) return result;
  }
  result = load_request(request_path, &next, 0);
  if (result != ERROR_SUCCESS) return result;
  result = create_only_file(pending_path, next.raw, next.raw_bytes);
  if (result == ERROR_SUCCESS) result = apply_services(&next);
  if (result == ERROR_SUCCESS) result = replace_active_file(temporary_path, active_path, next.raw, next.raw_bytes);
  if (result != ERROR_SUCCESS) {
    DWORD rollback = restore_active(active_path, pending_path);
    if (rollback != ERROR_SUCCESS) result = rollback;
  } else if (!DeleteFileW(pending_path)) {
    result = GetLastError();
  }
  free_actuation_request(&next);
  return result;
}

static DWORD probe_active(const wchar_t *active_path) {
  actuation_request request;
  SC_HANDLE manager;
  unsigned char index;
  DWORD result = load_request(active_path, &request, 0);
  if (result != ERROR_SUCCESS) return result;
  manager = OpenSCManagerW(NULL, SERVICES_ACTIVE_DATABASE, SC_MANAGER_CONNECT);
  if (manager == NULL) { free_actuation_request(&request); return GetLastError(); }
  for (index = 0; index < request.service_count && result == ERROR_SUCCESS; index++) {
    SC_HANDLE service = OpenServiceW(manager, request.services[index].service_name, SERVICE_QUERY_STATUS);
    SERVICE_STATUS_PROCESS status;
    DWORD needed;
    if (service == NULL) { result = GetLastError(); break; }
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (LPBYTE) &status, sizeof(status), &needed)
      || status.dwCurrentState != SERVICE_RUNNING) result = ERROR_SERVICE_NOT_ACTIVE;
    CloseServiceHandle(service);
    if (result == ERROR_SUCCESS) result = verify_service_parameters(&request.services[index]);
  }
  CloseServiceHandle(manager);
  free_actuation_request(&request);
  return result;
}

static DWORD actuator_paths(
  wchar_t **directory,
  wchar_t **request_path,
  wchar_t **active_path,
  wchar_t **temporary_path,
  wchar_t **pending_path
) {
  PWSTR program_data = NULL;
  size_t directory_chars;
  HRESULT status = SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, NULL, &program_data);
  if (FAILED(status) || program_data == NULL) return ERROR_PATH_NOT_FOUND;
  directory_chars = wcslen(program_data) + 1 + wcslen(ACTUATOR_DIRECTORY) + 1;
  *directory = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, directory_chars * sizeof(wchar_t));
  if (*directory == NULL) { CoTaskMemFree(program_data); return ERROR_NOT_ENOUGH_MEMORY; }
  if (_snwprintf_s(*directory, directory_chars, _TRUNCATE, L"%ls\\%ls", program_data, ACTUATOR_DIRECTORY) < 0) {
    CoTaskMemFree(program_data); return ERROR_INVALID_DATA;
  }
  CoTaskMemFree(program_data);
#define MAKE_PATH(output, file_name) do { \
  size_t chars = wcslen(*directory) + 1 + wcslen(file_name) + 1; \
  *(output) = (wchar_t *) HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, chars * sizeof(wchar_t)); \
  if (*(output) == NULL || _snwprintf_s(*(output), chars, _TRUNCATE, L"%ls\\%ls", *directory, file_name) < 0) \
    return ERROR_NOT_ENOUGH_MEMORY; \
} while (0)
  MAKE_PATH(request_path, REQUEST_FILE);
  MAKE_PATH(active_path, ACTIVE_FILE);
  MAKE_PATH(temporary_path, ACTIVE_TEMP_FILE);
  MAKE_PATH(pending_path, PENDING_FILE);
#undef MAKE_PATH
  return ERROR_SUCCESS;
}

static int write_identity(void) {
#if defined(_M_ARM64) || defined(__aarch64__)
  static const char identity[] = "{\"schemaVersion\":\"deviludo.windows-scm-native-actuator-identity.v1\",\"component\":\"deviludo-windows-scm-native-actuator\",\"version\":\"1.1.0\",\"requestContractVersion\":1,\"platform\":\"windows\",\"architecture\":\"arm64\"}\n";
#elif defined(_M_X64) || defined(__x86_64__)
  static const char identity[] = "{\"schemaVersion\":\"deviludo.windows-scm-native-actuator-identity.v1\",\"component\":\"deviludo-windows-scm-native-actuator\",\"version\":\"1.1.0\",\"requestContractVersion\":1,\"platform\":\"windows\",\"architecture\":\"x86_64\"}\n";
#else
#error Unsupported Windows SCM actuator architecture
#endif
  DWORD written = 0;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  return output != INVALID_HANDLE_VALUE
    && WriteFile(output, identity, (DWORD) (sizeof(identity) - 1), &written, NULL)
    && written == sizeof(identity) - 1 ? 0 : 1;
}

int wmain(int argc, wchar_t **argv) {
  HANDLE mutex = NULL;
  wchar_t *directory = NULL;
  wchar_t *request_path = NULL;
  wchar_t *active_path = NULL;
  wchar_t *temporary_path = NULL;
  wchar_t *pending_path = NULL;
  DWORD result;
  if (argc == 2 && wcscmp(argv[1], L"--identity") == 0) return write_identity();
  if (argc != 2 || (wcscmp(argv[1], L"--apply") != 0 && wcscmp(argv[1], L"--restore") != 0
    && wcscmp(argv[1], L"--probe") != 0)) return ERROR_INVALID_PARAMETER;
  mutex = CreateMutexW(NULL, FALSE, ACTUATOR_MUTEX);
  if (mutex == NULL) return (int) GetLastError();
  {
    DWORD wait_result = WaitForSingleObject(mutex, 30000);
    if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED_0) { CloseHandle(mutex); return ERROR_BUSY; }
  }
  result = actuator_paths(&directory, &request_path, &active_path, &temporary_path, &pending_path);
  if (result == ERROR_SUCCESS) {
    DWORD attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
      || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) result = ERROR_PATH_NOT_FOUND;
  }
  if (result == ERROR_SUCCESS && wcscmp(argv[1], L"--apply") == 0) {
    result = apply_request(request_path, active_path, temporary_path, pending_path);
  } else if (result == ERROR_SUCCESS && wcscmp(argv[1], L"--restore") == 0) {
    result = restore_active(active_path, pending_path);
  } else if (result == ERROR_SUCCESS) {
    result = probe_active(active_path);
  }
  if (result == ERROR_SUCCESS) {
    static const char success[] = "{\"schemaVersion\":\"deviludo.windows-scm-native-actuation-result.v1\",\"status\":\"SUCCEEDED\"}\n";
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), success, (DWORD) (sizeof(success) - 1), &written, NULL);
  }
  secure_free(pending_path, pending_path == NULL ? 0 : (wcslen(pending_path) + 1) * sizeof(wchar_t));
  secure_free(temporary_path, temporary_path == NULL ? 0 : (wcslen(temporary_path) + 1) * sizeof(wchar_t));
  secure_free(active_path, active_path == NULL ? 0 : (wcslen(active_path) + 1) * sizeof(wchar_t));
  secure_free(request_path, request_path == NULL ? 0 : (wcslen(request_path) + 1) * sizeof(wchar_t));
  secure_free(directory, directory == NULL ? 0 : (wcslen(directory) + 1) * sizeof(wchar_t));
  ReleaseMutex(mutex);
  CloseHandle(mutex);
  return (int) result;
}
