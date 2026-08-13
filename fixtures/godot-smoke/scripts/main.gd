extends Control

const GameState = preload("res://scripts/game_state.gd")

var state := GameState.new()
var selection_index := 0
var selection_panel: ColorRect
var selection_label: Label
var status_label: Label
var completion_overlay: ColorRect
var menu_checkpoint_emitted := false
var completion_checkpoint_emitted := false

func _ready() -> void:
	state.collect_ember("harbor")
	_build_interface()
	call_deferred("_announce_game_start")

func _announce_game_start() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	_emit_checkpoint("game-start")
	print("DEVILUDO_FIXTURE_BOOT:", JSON.stringify(state.to_snapshot()))

func _unhandled_key_input(event: InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.keycode == KEY_DOWN or event.keycode == KEY_S:
		selection_index = 1
		selection_panel.color = Color("1d7791")
		selection_label.text = "CONTINUE LOOP  >"
		status_label.text = "INPUT RECEIVED  /  ROUTE ARMED"
		if not menu_checkpoint_emitted:
			menu_checkpoint_emitted = true
			_emit_checkpoint("menu-selection")
	elif event.keycode == KEY_ENTER and selection_index == 1:
		completion_overlay.visible = true
		status_label.text = "CORE LOOP COMPLETE  /  EVIDENCE READY"
		if not completion_checkpoint_emitted:
			completion_checkpoint_emitted = true
			_emit_checkpoint("core-loop-complete")

func _build_interface() -> void:
	var background := ColorRect.new()
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.color = Color("0e1621")
	add_child(background)

	var header := ColorRect.new()
	header.position = Vector2(0, 0)
	header.size = Vector2(1280, 116)
	header.color = Color("15283a")
	background.add_child(header)
	header.add_child(_label("DEVILUDO  //  REAL WINDOW E2E", Vector2(64, 30), 34, Color("72dcff")))
	header.add_child(_label("ISOLATED GAME SESSION", Vector2(882, 40), 22, Color("b9c9d6")))

	var title := _label("TIME LOOP CONTROL", Vector2(78, 165), 56, Color("f2f7fa"))
	background.add_child(title)
	background.add_child(_label("A deterministic interactive smoke journey", Vector2(82, 235), 25, Color("8fa7b8")))

	selection_panel = ColorRect.new()
	selection_panel.position = Vector2(80, 314)
	selection_panel.size = Vector2(720, 178)
	selection_panel.color = Color("a25c20")
	background.add_child(selection_panel)
	selection_panel.add_child(_label("SELECT ROUTE", Vector2(34, 25), 22, Color("ffe0ae")))
	selection_label = _label("NEW LOOP", Vector2(34, 72), 42, Color("ffffff"))
	selection_panel.add_child(selection_label)

	var telemetry := ColorRect.new()
	telemetry.position = Vector2(844, 165)
	telemetry.size = Vector2(354, 327)
	telemetry.color = Color("172b32")
	background.add_child(telemetry)
	telemetry.add_child(_label("RUN TELEMETRY", Vector2(28, 28), 24, Color("65e2c2")))
	telemetry.add_child(_label("EMBER", Vector2(28, 92), 20, Color("90a7ae")))
	telemetry.add_child(_label("01 / 03", Vector2(190, 84), 32, Color("ffffff")))
	telemetry.add_child(_label("HULL", Vector2(28, 164), 20, Color("90a7ae")))
	telemetry.add_child(_label("100%", Vector2(215, 156), 32, Color("ffffff")))
	telemetry.add_child(_label("WINDOW", Vector2(28, 236), 20, Color("90a7ae")))
	telemetry.add_child(_label("1280 x 720", Vector2(164, 231), 25, Color("72dcff")))

	var footer := ColorRect.new()
	footer.position = Vector2(0, 586)
	footer.size = Vector2(1280, 134)
	footer.color = Color("111f2b")
	background.add_child(footer)
	status_label = _label("PRESS DOWN TO SELECT  /  ENTER TO CONFIRM", Vector2(80, 46), 28, Color("e7edf2"))
	footer.add_child(status_label)

	completion_overlay = ColorRect.new()
	completion_overlay.position = Vector2(80, 314)
	completion_overlay.size = Vector2(1118, 178)
	completion_overlay.color = Color("15806b")
	completion_overlay.visible = false
	background.add_child(completion_overlay)
	completion_overlay.add_child(_label("CORE LOOP COMPLETE", Vector2(42, 34), 42, Color("ffffff")))
	completion_overlay.add_child(_label("REAL INPUT AND VISIBLE STATE TRANSITION VERIFIED", Vector2(44, 101), 23, Color("c9fff0")))

func _label(text: String, position: Vector2, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text
	label.position = position
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	return label

func _emit_checkpoint(checkpoint_id: String) -> void:
	var marker := "DEVILUDO_E2E_CHECKPOINT:%s" % checkpoint_id
	print(marker)
	var output_path := OS.get_environment("DEVILUDO_E2E_CHECKPOINT_FILE")
	if output_path.is_empty():
		return
	var output := FileAccess.open(output_path, FileAccess.READ_WRITE)
	if output == null:
		output = FileAccess.open(output_path, FileAccess.WRITE)
	else:
		output.seek_end()
	if output != null:
		output.store_line(marker)
		output.flush()
