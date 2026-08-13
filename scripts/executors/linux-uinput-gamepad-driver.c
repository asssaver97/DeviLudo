#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <json-c/json.h>
#include <linux/input-event-codes.h>
#include <linux/uinput.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

// System-visible Linux gamepad transport. It writes EV_KEY/EV_ABS reports to
// uinput, so Godot observes the device through the kernel input stack. The
// tested process is never linked to or injected with synthetic InputEvents.

static int device_fd = -1;
static bool destroyed = false;

struct named_code { const char *name; int code; };
static const struct named_code buttons[] = {
  {"A", BTN_SOUTH}, {"B", BTN_EAST}, {"X", BTN_WEST}, {"Y", BTN_NORTH},
  {"BACK", BTN_SELECT}, {"GUIDE", BTN_MODE}, {"START", BTN_START},
  {"LEFT_STICK", BTN_THUMBL}, {"RIGHT_STICK", BTN_THUMBR},
  {"LEFT_SHOULDER", BTN_TL}, {"RIGHT_SHOULDER", BTN_TR},
  {"DPAD_UP", BTN_DPAD_UP}, {"DPAD_DOWN", BTN_DPAD_DOWN},
  {"DPAD_LEFT", BTN_DPAD_LEFT}, {"DPAD_RIGHT", BTN_DPAD_RIGHT},
};
static const struct named_code axes[] = {
  {"LEFT_X", ABS_X}, {"LEFT_Y", ABS_Y}, {"RIGHT_X", ABS_RX}, {"RIGHT_Y", ABS_RY},
};

static void emit_event(uint16_t type, uint16_t code, int32_t value) {
  struct input_event event = {0};
  event.type = type; event.code = code; event.value = value;
  if (write(device_fd, &event, sizeof(event)) != (ssize_t)sizeof(event)) {
    fprintf(stderr, "uinput report failed: %s\n", strerror(errno));
    exit(74);
  }
}

static void sync_report(void) { emit_event(EV_SYN, SYN_REPORT, 0); }

static void release_all(void) {
  if (device_fd < 0 || destroyed) return;
  for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i++) emit_event(EV_KEY, buttons[i].code, 0);
  for (size_t i = 0; i < sizeof(axes) / sizeof(axes[0]); i++) emit_event(EV_ABS, axes[i].code, 0);
  emit_event(EV_ABS, ABS_Z, 0); emit_event(EV_ABS, ABS_RZ, 0); sync_report();
}

static void destroy_device(void) {
  if (device_fd < 0 || destroyed) return;
  release_all();
  ioctl(device_fd, UI_DEV_DESTROY);
  close(device_fd); device_fd = -1; destroyed = true;
}

static void terminate(int signal_number) { (void)signal_number; destroy_device(); _exit(128); }

static void sleep_ms(int duration_ms) {
  struct timespec duration = { .tv_sec = duration_ms / 1000, .tv_nsec = (duration_ms % 1000) * 1000000L };
  while (nanosleep(&duration, &duration) < 0 && errno == EINTR) {}
}

static int lookup(const struct named_code *entries, size_t count, const char *name) {
  for (size_t i = 0; i < count; i++) if (strcmp(entries[i].name, name) == 0) return entries[i].code;
  return -1;
}

static bool integer_field(json_object *object, const char *name, int minimum, int maximum, int *result, bool optional) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(object, name, &value)) return optional;
  if (!json_object_is_type(value, json_type_int)) return false;
  int64_t number = json_object_get_int64(value);
  if (number < minimum || number > maximum) return false;
  *result = (int)number; return true;
}

static bool double_field(json_object *object, const char *name, double minimum, double maximum, double *result) {
  json_object *value = NULL;
  if (!json_object_object_get_ex(object, name, &value)
      || !(json_object_is_type(value, json_type_double) || json_object_is_type(value, json_type_int))) return false;
  double number = json_object_get_double(value);
  if (number < minimum || number > maximum) return false;
  *result = number; return true;
}

static const char *string_field(json_object *object, const char *name) {
  json_object *value = NULL;
  return json_object_object_get_ex(object, name, &value) && json_object_is_type(value, json_type_string)
    ? json_object_get_string(value) : NULL;
}

static bool perform_event(json_object *event) {
  const char *type = string_field(event, "type");
  if (!type) return false;
  if (strcmp(type, "gamepad_release_all") == 0) { release_all(); return true; }
  if (strcmp(type, "gamepad_button_tap") == 0 || strcmp(type, "gamepad_button_hold") == 0) {
    const char *name = string_field(event, "button");
    int code = name ? lookup(buttons, sizeof(buttons) / sizeof(buttons[0]), name) : -1;
    int duration_ms = strcmp(type, "gamepad_button_tap") == 0 ? 80 : 0;
    if (code < 0 || (strcmp(type, "gamepad_button_hold") == 0
      && !integer_field(event, "duration_ms", 1, 2000, &duration_ms, false))) return false;
    emit_event(EV_KEY, code, 1); sync_report(); sleep_ms(duration_ms);
    emit_event(EV_KEY, code, 0); sync_report(); return true;
  }
  if (strcmp(type, "gamepad_axis") == 0) {
    const char *name = string_field(event, "axis"); double value = 0; int duration_ms = 0;
    int code = name ? lookup(axes, sizeof(axes) / sizeof(axes[0]), name) : -1;
    if (code < 0 || !double_field(event, "value", -1, 1, &value)
      || !integer_field(event, "duration_ms", 1, 2000, &duration_ms, true)) return false;
    emit_event(EV_ABS, code, (int32_t)(value * 32767)); sync_report();
    if (duration_ms > 0) { sleep_ms(duration_ms); emit_event(EV_ABS, code, 0); sync_report(); }
    return true;
  }
  if (strcmp(type, "gamepad_trigger") == 0) {
    const char *name = string_field(event, "trigger"); double value = 0; int duration_ms = 0;
    if (!name || (strcmp(name, "LEFT") != 0 && strcmp(name, "RIGHT") != 0)
      || !double_field(event, "value", 0, 1, &value)
      || !integer_field(event, "duration_ms", 1, 2000, &duration_ms, true)) return false;
    int code = strcmp(name, "LEFT") == 0 ? ABS_Z : ABS_RZ;
    emit_event(EV_ABS, code, (int32_t)(value * 1023)); sync_report();
    if (duration_ms > 0) { sleep_ms(duration_ms); emit_event(EV_ABS, code, 0); sync_report(); }
    return true;
  }
  return false;
}

static void response(const char *id, bool ok, const char *error) {
  json_object *value = json_object_new_object();
  json_object_object_add(value, "id", json_object_new_string(id ? id : "unknown"));
  json_object_object_add(value, "ok", json_object_new_boolean(ok));
  if (!ok) json_object_object_add(value, "error", json_object_new_string(error ? error : "virtual gamepad rejected input"));
  puts(json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN)); fflush(stdout); json_object_put(value);
}

static void configure_abs(int code, int minimum, int maximum) {
  struct uinput_abs_setup setup = {0};
  setup.code = (uint16_t)code; setup.absinfo.minimum = minimum; setup.absinfo.maximum = maximum;
  setup.absinfo.flat = code == ABS_Z || code == ABS_RZ ? 0 : 1024;
  if (ioctl(device_fd, UI_ABS_SETUP, &setup) < 0) { perror("UI_ABS_SETUP"); exit(71); }
}

static void create_device(void) {
  device_fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (device_fd < 0) { perror("open /dev/uinput"); exit(69); }
  ioctl(device_fd, UI_SET_EVBIT, EV_KEY); ioctl(device_fd, UI_SET_EVBIT, EV_ABS); ioctl(device_fd, UI_SET_EVBIT, EV_SYN);
  for (size_t i = 0; i < sizeof(buttons) / sizeof(buttons[0]); i++) ioctl(device_fd, UI_SET_KEYBIT, buttons[i].code);
  for (size_t i = 0; i < sizeof(axes) / sizeof(axes[0]); i++) { ioctl(device_fd, UI_SET_ABSBIT, axes[i].code); configure_abs(axes[i].code, -32767, 32767); }
  ioctl(device_fd, UI_SET_ABSBIT, ABS_Z); configure_abs(ABS_Z, 0, 1023);
  ioctl(device_fd, UI_SET_ABSBIT, ABS_RZ); configure_abs(ABS_RZ, 0, 1023);
  struct uinput_setup setup = {0};
  setup.id.bustype = BUS_USB; setup.id.vendor = 0x1209; setup.id.product = 0xD311; setup.id.version = 1;
  snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "DeviLudo Virtual Gamepad");
  if (ioctl(device_fd, UI_DEV_SETUP, &setup) < 0 || ioctl(device_fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); exit(71); }
  sleep_ms(300); release_all();
}

int main(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "serve") != 0) { fprintf(stderr, "usage: %s serve --session ID\n", argv[0]); return 64; }
  signal(SIGINT, terminate); signal(SIGTERM, terminate); signal(SIGHUP, terminate);
  create_device();
  char *line = NULL; size_t capacity = 0;
  while (getline(&line, &capacity, stdin) >= 0) {
    json_object *command = json_tokener_parse(line); const char *id = command ? string_field(command, "id") : NULL;
    const char *name = command ? string_field(command, "command") : NULL; bool ok = false; bool exit_after = false;
    if (name && (strcmp(name, "ready") == 0 || strcmp(name, "release_all") == 0)) { release_all(); ok = true; }
    else if (name && strcmp(name, "destroy") == 0) { release_all(); ok = true; exit_after = true; }
    else if (name && strcmp(name, "sequence") == 0) {
      json_object *events = NULL;
      if (json_object_object_get_ex(command, "events", &events) && json_object_is_type(events, json_type_array)
        && json_object_array_length(events) >= 1 && json_object_array_length(events) <= 200) {
        ok = true;
        for (size_t i = 0; i < json_object_array_length(events); i++) if (!perform_event(json_object_array_get_idx(events, i))) { ok = false; break; }
      }
      if (!ok) release_all();
    }
    response(id, ok, ok ? NULL : "invalid or unsafe gamepad command");
    if (command) json_object_put(command);
    if (exit_after) break;
  }
  free(line); destroy_device(); return 0;
}
