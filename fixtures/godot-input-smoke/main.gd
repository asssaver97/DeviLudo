extends Node2D

var marker_path := ""

func _ready() -> void:
	marker_path = OS.get_environment("DEVILUDO_GAMEPAD_SMOKE_MARKER")
	get_window().size = Vector2i(1280, 720)
	get_tree().create_timer(20.0).timeout.connect(func() -> void: get_tree().quit(2))

func _input(event: InputEvent) -> void:
	if event is InputEventJoypadButton and event.pressed:
		if marker_path.is_empty():
			get_tree().quit(3)
			return
		var file := FileAccess.open(marker_path, FileAccess.WRITE)
		if file == null:
			get_tree().quit(4)
			return
		file.store_string("system-gamepad-ok\n")
		file.close()
		get_tree().quit(0)
