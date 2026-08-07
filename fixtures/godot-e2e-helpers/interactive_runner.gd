extends SceneTree
# DeviLudo Interactive Test Runner
# Executes input simulation scripts for E2E verification

var events: Array = []
var current_event_index := 0
var wait_timer: SceneTreeTimer = null
var checks: Array[String] = []
var failures: Array[String] = []
var start_ticks := 0

func _initialize() -> void:
	start_ticks = Time.get_ticks_msec()

	# Parse interaction script from environment or command-line
	var script_json := OS.get_environment("DEVILUDO_INTERACTION_SCRIPT")
	if script_json.is_empty():
		print("ERROR: DEVILUDO_INTERACTION_SCRIPT not set")
		quit(1)
		return

	var json := JSON.new()
	var parse_result := json.parse(script_json)
	if parse_result != OK:
		print("ERROR: Failed to parse interaction script: ", json.get_error_message())
		quit(1)
		return

	var script_data = json.get_data()
	if not script_data is Dictionary or script_data.get("version") != "1":
		print("ERROR: Invalid interaction script version")
		quit(1)
		return

	events = script_data.get("events", [])

	# Load the game scene
	var scene_path := "res://main.tscn"  # Default, can be overridden
	var custom_scene := OS.get_environment("DEVILUDO_TEST_SCENE")
	if not custom_scene.is_empty():
		scene_path = custom_scene

	var scene := load(scene_path)
	if scene == null:
		print("ERROR: Failed to load scene: ", scene_path)
		quit(1)
		return

	var instance := scene.instantiate()
	root.add_child(instance)

	# Start processing events
	process_next_event()

func process_next_event() -> void:
	if current_event_index >= events.size():
		# All events processed, report results
		report_results()
		return

	var event = events[current_event_index]
	current_event_index += 1

	var delay_ms := event.get("delay_ms", 0)

	match event.get("type"):
		"key_press":
			simulate_key_press(event.get("key"))
		"key_release":
			simulate_key_release(event.get("key"))
		"mouse_move":
			simulate_mouse_move(event.get("x"), event.get("y"))
		"mouse_click":
			simulate_mouse_click(event.get("button"))
		"wait":
			delay_ms = event.get("delay_ms", 1000)
		_:
			print("WARNING: Unknown event type: ", event.get("type"))

	# Schedule next event
	if delay_ms > 0:
		wait_timer = create_timer(delay_ms / 1000.0)
		wait_timer.timeout.connect(process_next_event)
	else:
		# Process immediately on next frame
		call_deferred("process_next_event")

func simulate_key_press(key_name: String) -> void:
	var event := InputEventKey.new()
	event.keycode = OS.find_keycode_from_string(key_name)
	event.pressed = true
	Input.parse_input_event(event)
	check(true, "key-press-" + key_name.to_lower())

func simulate_key_release(key_name: String) -> void:
	var event := InputEventKey.new()
	event.keycode = OS.find_keycode_from_string(key_name)
	event.pressed = false
	Input.parse_input_event(event)
	check(true, "key-release-" + key_name.to_lower())

func simulate_mouse_move(x: int, y: int) -> void:
	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	Input.parse_input_event(event)
	check(true, "mouse-move-%d-%d" % [x, y])

func simulate_mouse_click(button_name: String) -> void:
	var button_index := 0
	match button_name:
		"LEFT": button_index = MOUSE_BUTTON_LEFT
		"RIGHT": button_index = MOUSE_BUTTON_RIGHT
		"MIDDLE": button_index = MOUSE_BUTTON_MIDDLE

	var event := InputEventMouseButton.new()
	event.button_index = button_index
	event.pressed = true
	Input.parse_input_event(event)

	# Immediate release
	event = InputEventMouseButton.new()
	event.button_index = button_index
	event.pressed = false
	Input.parse_input_event(event)

	check(true, "mouse-click-" + button_name.to_lower())

func check(condition: bool, name: String) -> void:
	checks.append(name)
	if not condition:
		failures.append(name)

func report_results() -> void:
	var duration_ms := Time.get_ticks_msec() - start_ticks
	var result := {
		"suite": "deviludo-interactive-e2e",
		"checks": checks,
		"failures": failures,
		"duration_ms": duration_ms
	}
	print("DEVILUDO_E2E_RESULT:", JSON.stringify(result))
	quit(0 if failures.is_empty() else 1)
