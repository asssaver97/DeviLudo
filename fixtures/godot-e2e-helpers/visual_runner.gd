extends SceneTree
# DeviLudo Visual Test Runner
# Captures screenshots and compares against reference images

var reference_image: String
var threshold: float = 0.01
var capture_delay: int = 1000
var start_ticks := 0

func _initialize() -> void:
	start_ticks = Time.get_ticks_msec()

	# Parse visual test spec from environment
	var spec_json := OS.get_environment("DEVILUDO_VISUAL_SPEC")
	if spec_json.is_empty():
		print("ERROR: DEVILUDO_VISUAL_SPEC not set")
		quit(1)
		return

	var json := JSON.new()
	var parse_result := json.parse(spec_json)
	if parse_result != OK:
		print("ERROR: Failed to parse visual spec: ", json.get_error_message())
		quit(1)
		return

	var spec_data = json.get_data()
	if not spec_data is Dictionary or spec_data.get("version") != "1":
		print("ERROR: Invalid visual spec version")
		quit(1)
		return

	reference_image = spec_data.get("referenceImage", "")
	threshold = spec_data.get("threshold", 0.01)
	capture_delay = spec_data.get("captureDelay", 1000)

	if reference_image.is_empty():
		print("ERROR: referenceImage not specified")
		quit(1)
		return

	# Load the game scene
	var scene_path := "res://main.tscn"
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

	# Wait for scene to settle, then capture
	var timer := create_timer(capture_delay / 1000.0)
	timer.timeout.connect(capture_and_compare)

func capture_and_compare() -> void:
	var output_path := OS.get_environment("DEVILUDO_SCREENSHOT_OUTPUT")
	if output_path.is_empty():
		output_path = "/tmp/deviludo_capture.png"

	# Capture current viewport
	var viewport := root.get_viewport()
	var img := viewport.get_texture().get_image()

	# Save captured image
	var save_result := img.save_png(output_path)
	if save_result != OK:
		print("ERROR: Failed to save screenshot")
		quit(1)
		return

	# Note: Actual pixel comparison happens in the Node.js executor
	# We just output metadata here for the executor to process
	var duration_ms := Time.get_ticks_msec() - start_ticks
	var result := {
		"suite": "deviludo-visual-e2e",
		"checks": ["visual-capture"],
		"failures": [],
		"duration_ms": duration_ms,
		"capturedImage": output_path,
		"referenceImage": reference_image,
		"threshold": threshold
	}
	print("DEVILUDO_E2E_RESULT:", JSON.stringify(result))
	quit(0)
