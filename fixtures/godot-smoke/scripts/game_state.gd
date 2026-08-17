class_name EmberVoyagerGameState
extends RefCounted

const REQUIRED_EMBERS := 3

var embers: Array[String] = []
var hull := 100
var elapsed_seconds := 0.0
var paused := false
var language := "zh-CN"

func collect_ember(ember_id: String) -> bool:
	if ember_id.is_empty() or embers.has(ember_id):
		return false
	embers.append(ember_id)
	return true

func apply_damage(amount: int) -> void:
	hull = clampi(hull - maxi(amount, 0), 0, 100)

func advance_time(seconds: float) -> void:
	if not paused:
		elapsed_seconds += maxf(seconds, 0.0)

func has_won() -> bool:
	return embers.size() >= REQUIRED_EMBERS and hull > 0 and elapsed_seconds <= 1200.0

func to_snapshot() -> Dictionary:
	return {
		"embers": embers.duplicate(),
		"hull": hull,
		"elapsed_seconds": elapsed_seconds,
		"paused": paused,
		"language": language,
	}

func restore(snapshot: Dictionary) -> void:
	embers.clear()
	for ember_id in snapshot.get("embers", []):
		var clean_id := str(ember_id)
		if not clean_id.is_empty() and not embers.has(clean_id):
			embers.append(clean_id)
	hull = clampi(int(snapshot.get("hull", 100)), 0, 100)
	elapsed_seconds = maxf(float(snapshot.get("elapsed_seconds", 0.0)), 0.0)
	paused = bool(snapshot.get("paused", false))
	language = str(snapshot.get("language", "zh-CN"))
