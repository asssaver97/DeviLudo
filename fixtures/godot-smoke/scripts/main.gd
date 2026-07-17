extends Node

const GameState = preload("res://scripts/game_state.gd")

func _ready() -> void:
	var state := GameState.new()
	state.collect_ember("harbor")
	print("DEVILUDO_FIXTURE_BOOT:", JSON.stringify(state.to_snapshot()))
	get_tree().quit(0)
