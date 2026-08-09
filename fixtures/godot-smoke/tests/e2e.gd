extends SceneTree

# DeviLudo E2E Test Reference Implementation
#
# This test script demonstrates the required pattern for automated feature verification.
# Agent-generated projects should follow this structure:
#
# 1. Extend SceneTree and run all tests in _initialize()
# 2. Use check(condition, name) for each assertion
# 3. Assertion names must be kebab-case and match checkNames in agent.json testManifest
# 4. Output structured results: print("DEVILUDO_E2E_RESULT:", JSON.stringify(...))
# 5. Exit with quit(0 if failures.is_empty() else 1)
#
# Each check() call corresponds to one feature verification point.
# Group related checks by feature (e.g. all ember collection checks, all pause checks).

const GameState = preload("res://scripts/game_state.gd")

var failures: Array[String] = []
var checks: Array[String] = []

func _initialize() -> void:
	var started_at := Time.get_ticks_usec()
	var state := GameState.new()

	# Feature: collect-ember (core-loop)
	check(state.collect_ember("ember-a"), "collect-first-ember")
	check(not state.collect_ember("ember-a"), "reject-duplicate-ember")

	# Feature: pause-system (player-control)
	state.advance_time(240.0)
	state.paused = true
	state.advance_time(99.0)
	check(is_equal_approx(state.elapsed_seconds, 240.0), "pause-stops-clock")
	state.paused = false

	# Feature: damage-system (core-loop)
	state.apply_damage(25)
	check(state.hull == 75, "damage-reduces-hull")

	# Feature: win-condition (core-loop)
	state.collect_ember("ember-b")
	state.collect_ember("ember-c")
	check(state.has_won(), "twenty-minute-core-loop-win")

	# Feature: save-persistence (data-integrity)
	var save_path := "user://deviludo-local-save.json"
	var writer := FileAccess.open(save_path, FileAccess.WRITE)
	check(writer != null, "save-open-write")
	if writer:
		writer.store_string(JSON.stringify(state.to_snapshot()))
		writer.close()

	var reader := FileAccess.open(save_path, FileAccess.READ)
	check(reader != null, "save-open-read")
	if reader:
		var decoded = JSON.parse_string(reader.get_as_text())
		reader.close()
		check(typeof(decoded) == TYPE_DICTIONARY, "save-json-valid")
		if typeof(decoded) == TYPE_DICTIONARY:
			var restored := GameState.new()
			restored.restore(decoded)
			check(restored.to_snapshot() == state.to_snapshot(), "save-round-trip")

	# Feature: headless-performance (runtime-quality)
	var duration_ms := float(Time.get_ticks_usec() - started_at) / 1000.0
	check(duration_ms < 250.0, "headless-performance-budget")

	# Output structured results
	var result := {
		"suite": "deviludo-local-godot-e2e",
		"checks": checks,
		"failures": failures,
		"duration_ms": duration_ms,
	}
	print("DEVILUDO_E2E_RESULT:", JSON.stringify(result))
	quit(0 if failures.is_empty() else 1)

func check(condition: bool, name: String) -> void:
	checks.append(name)
	if not condition:
		failures.append(name)
