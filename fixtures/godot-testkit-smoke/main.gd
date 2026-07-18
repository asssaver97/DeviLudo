extends Node

var phase := "core"
var paused := false
var settings_open := false
var coins := 7
var saved_coins := 0

func _ready() -> void:
	add_to_group("deviludo.core_loop")

func _process(_delta: float) -> void:
	if Input.is_action_just_pressed("test_win"):
		phase = "win"
	if Input.is_action_just_pressed("test_lose"):
		phase = "lose"
	if Input.is_action_just_pressed("test_pause"):
		paused = true
		settings_open = true
	if Input.is_action_just_pressed("test_save"):
		saved_coins = coins
	if Input.is_action_just_pressed("test_mutate"):
		coins = 99
	if Input.is_action_just_pressed("test_load"):
		coins = saved_coins
