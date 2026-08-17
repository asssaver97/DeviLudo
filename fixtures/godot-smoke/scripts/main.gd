extends Control

const GameState = preload("res://scripts/game_state.gd")
const SAVE_PATH := "user://deviludo-save.json"
const WORLD_SIZE := Vector2(1280, 720)
const SHIP_SPEED := 280.0

var state := GameState.new()
var screen_mode := "MENU"
var probe_sequence := 0
var loop_complete := false
var failed := false
var route_id := "aurora"
var collected_nodes: Dictionary = {}
var active_hazard_contacts: Dictionary = {}
var route_target := Vector2.ZERO
var has_route_target := false
var last_probe_rects: Dictionary = {}

var menu_layer: Control
var game_layer: Control
var pause_layer: Control
var result_layer: Control
var ship: ColorRect
var ember_nodes: Array[Control] = []
var hazard_nodes: Array[Control] = []
var ember_label: Label
var hull_label: Label
var time_label: Label
var objective_label: Label
var result_title: Label
var result_detail: Label
var new_game_button: Button
var continue_button: Button
var quit_button: Button
var resume_button: Button
var menu_button: Button
var restart_button: Button
var result_menu_button: Button

func _ready() -> void:
	set_process(true)
	_build_interface()
	_show_menu()
	call_deferred("_announce_ready")

func _announce_ready() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	_publish_probe()
	_emit_checkpoint("game-start")
	print("DEVILUDO_GAME_READY")

func _process(delta: float) -> void:
	if screen_mode != "PLAYING":
		return
	var direction := Vector2(
		float(Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT)) - float(Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT)),
		float(Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN)) - float(Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP))
	)
	if direction.length_squared() > 0.0:
		has_route_target = false
		ship.position += direction.normalized() * SHIP_SPEED * delta
	elif has_route_target:
		var distance := ship.position.distance_to(route_target)
		if distance <= SHIP_SPEED * delta:
			ship.position = route_target
			has_route_target = false
		else:
			ship.position = ship.position.move_toward(route_target, SHIP_SPEED * delta)
		ship.position.x = clampf(ship.position.x, 34.0, 1198.0)
		ship.position.y = clampf(ship.position.y, 126.0, 614.0)
	state.advance_time(delta)
	_check_world_collisions()
	_update_hud()
	_publish_probe()

func _unhandled_key_input(event: InputEvent) -> void:
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if event.keycode == KEY_ESCAPE or event.keycode == KEY_P:
		if screen_mode == "PLAYING":
			_pause_game()
		elif screen_mode == "PAUSED":
			_resume_game()

func _on_game_input(event: InputEvent) -> void:
	if screen_mode != "PLAYING" or not event is InputEventMouseButton:
		return
	var mouse_event := event as InputEventMouseButton
	if mouse_event.button_index != MOUSE_BUTTON_LEFT or not mouse_event.pressed:
		return
	route_target = Vector2(
		clampf(mouse_event.position.x - ship.size.x * 0.5, 34.0, 1198.0),
		clampf(mouse_event.position.y - ship.size.y * 0.5, 126.0, 614.0)
	)
	has_route_target = true
	_publish_after_draw("")

func _build_interface() -> void:
	var background := TextureRect.new()
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	background.texture = _generated_texture("backgrounds/space-route")
	background.modulate = Color("25354e") if background.texture else Color("101a2c")
	add_child(background)

	menu_layer = Control.new()
	menu_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(menu_layer)
	var menu_panel := ColorRect.new()
	menu_panel.position = Vector2(330, 112)
	menu_panel.size = Vector2(620, 496)
	menu_panel.color = Color("d91a263d")
	menu_layer.add_child(menu_panel)
	menu_panel.add_child(_label("EMBER VOYAGER", Vector2(104, 54), 48, Color("ffe4a8")))
	menu_panel.add_child(_label("Choose the Aurora Route", Vector2(151, 122), 24, Color("bcd9ef")))
	menu_panel.add_child(_label("Collect three embers. Protect your hull.", Vector2(88, 170), 20, Color("a7b8c8")))
	new_game_button = _button("New Game", Vector2(130, 228), Vector2(360, 62), _start_new_game)
	continue_button = _button("Continue", Vector2(130, 304), Vector2(360, 62), _continue_game)
	quit_button = _button("Quit", Vector2(130, 380), Vector2(360, 54), _quit_game)
	menu_panel.add_child(new_game_button)
	menu_panel.add_child(continue_button)
	menu_panel.add_child(quit_button)

	game_layer = Control.new()
	game_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	game_layer.gui_input.connect(_on_game_input)
	add_child(game_layer)
	var top_bar := ColorRect.new()
	top_bar.size = Vector2(1280, 98)
	top_bar.color = Color("e0162538")
	game_layer.add_child(top_bar)
	objective_label = _label("AURORA ROUTE  •  COLLECT ALL EMBERS", Vector2(36, 20), 24, Color("d8edff"))
	top_bar.add_child(objective_label)
	ember_label = _label("EMBERS  0 / 3", Vector2(760, 20), 22, Color("ffcc6a"))
	hull_label = _label("HULL  100%", Vector2(960, 20), 22, Color("7ee3c2"))
	time_label = _label("00:00", Vector2(1142, 20), 22, Color.WHITE)
	top_bar.add_child(ember_label)
	top_bar.add_child(hull_label)
	top_bar.add_child(time_label)
	top_bar.add_child(_label("WASD / ARROWS TO FLY   •   P OR ESC TO PAUSE", Vector2(36, 60), 16, Color("8ca6bd")))

	for data in [["ember-west", Vector2(380, 330)], ["ember-mid", Vector2(650, 430)], ["ember-east", Vector2(930, 300)]]:
		var ember := ColorRect.new()
		ember.name = data[0]
		ember.position = data[1]
		ember.size = Vector2(34, 34)
		ember.color = Color("ff9f32")
		game_layer.add_child(ember)
		_apply_generated_art(ember, "sprites/ember")
		ember.add_child(_label("✦", Vector2(4, -5), 30, Color("fff3c4")))
		ember_nodes.append(ember)
	for position in [Vector2(520, 250), Vector2(780, 365), Vector2(1060, 480)]:
		var hazard := ColorRect.new()
		hazard.position = position
		hazard.size = Vector2(54, 54)
		hazard.color = Color("b83f5270")
		game_layer.add_child(hazard)
		_apply_generated_art(hazard, "sprites/hazard")
		hazard.add_child(_label("◆", Vector2(9, 1), 31, Color("ff8090")))
		hazard_nodes.append(hazard)
	ship = ColorRect.new()
	ship.name = "PlayerShip"
	ship.size = Vector2(48, 34)
	ship.color = Color("69d8ff")
	game_layer.add_child(ship)
	_apply_generated_art(ship, "sprites/player-ship")
	ship.add_child(_label("▶", Vector2(8, -5), 30, Color.WHITE))

	pause_layer = ColorRect.new()
	pause_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	pause_layer.color = Color("d008101b")
	add_child(pause_layer)
	var pause_panel := ColorRect.new()
	pause_panel.position = Vector2(390, 190)
	pause_panel.size = Vector2(500, 340)
	pause_panel.color = Color("f0213348")
	pause_layer.add_child(pause_panel)
	pause_panel.add_child(_label("VOYAGE PAUSED", Vector2(112, 46), 34, Color.WHITE))
	resume_button = _button("Resume", Vector2(100, 126), Vector2(300, 60), _resume_game)
	menu_button = _button("Save & Main Menu", Vector2(100, 204), Vector2(300, 60), _save_and_menu)
	pause_panel.add_child(resume_button)
	pause_panel.add_child(menu_button)

	result_layer = ColorRect.new()
	result_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	result_layer.color = Color("e008101b")
	add_child(result_layer)
	var result_panel := ColorRect.new()
	result_panel.position = Vector2(320, 150)
	result_panel.size = Vector2(640, 420)
	result_panel.color = Color("f0183440")
	result_layer.add_child(result_panel)
	result_title = _label("ROUTE COMPLETE", Vector2(145, 62), 42, Color("ffe39a"))
	result_detail = _label("Three embers recovered.", Vector2(170, 135), 23, Color("cae9e4"))
	result_panel.add_child(result_title)
	result_panel.add_child(result_detail)
	restart_button = _button("New Voyage", Vector2(150, 220), Vector2(340, 60), _start_new_game)
	result_menu_button = _button("Main Menu", Vector2(150, 298), Vector2(340, 60), _return_to_menu)
	result_panel.add_child(restart_button)
	result_panel.add_child(result_menu_button)

func _start_new_game() -> void:
	state = GameState.new()
	loop_complete = false
	failed = false
	collected_nodes.clear()
	active_hazard_contacts.clear()
	has_route_target = false
	for ember in ember_nodes:
		ember.visible = true
	ship.position = Vector2(150, 355)
	_enter_playing()
	_save_game()
	_publish_after_draw("route-selected")

func _continue_game() -> void:
	var snapshot := _read_valid_save()
	if snapshot.is_empty():
		_show_menu()
		return
	state = GameState.new()
	state.restore(snapshot)
	state.paused = false
	loop_complete = false
	failed = false
	collected_nodes.clear()
	active_hazard_contacts.clear()
	has_route_target = false
	for ember in ember_nodes:
		var collected := state.embers.has(str(ember.name))
		ember.visible = not collected
		if collected:
			collected_nodes[str(ember.name)] = true
	ship.position = _safe_vector(snapshot.get("ship_position", [150.0, 355.0]))
	_enter_playing()
	_publish_after_draw("route-selected")

func _enter_playing() -> void:
	screen_mode = "PLAYING"
	state.paused = false
	menu_layer.visible = false
	game_layer.visible = true
	pause_layer.visible = false
	result_layer.visible = false
	_update_hud()
	_publish_probe()

func _pause_game() -> void:
	state.paused = true
	screen_mode = "PAUSED"
	pause_layer.visible = true
	_save_game()
	_publish_after_draw("")

func _resume_game() -> void:
	state.paused = false
	screen_mode = "PLAYING"
	pause_layer.visible = false
	_publish_after_draw("")

func _show_menu() -> void:
	screen_mode = "MENU"
	# The menu is an inactive lifecycle state. Keep resumable progress only in the
	# validated disk save; never expose the previous voyage as a hidden session.
	state = GameState.new()
	loop_complete = false
	failed = false
	collected_nodes.clear()
	active_hazard_contacts.clear()
	has_route_target = false
	menu_layer.visible = true
	game_layer.visible = false
	pause_layer.visible = false
	result_layer.visible = false
	continue_button.disabled = _read_valid_save().is_empty()
	_publish_after_draw("")

func _save_and_menu() -> void:
	_save_game()
	_show_menu()

func _return_to_menu() -> void:
	_show_menu()

func _quit_game() -> void:
	get_tree().quit()

func _check_world_collisions() -> void:
	var ship_rect := ship.get_rect()
	var changed := false
	for ember in ember_nodes:
		if ember.visible and ship_rect.intersects(ember.get_rect()):
			if state.collect_ember(str(ember.name)):
				collected_nodes[str(ember.name)] = true
				ember.visible = false
				changed = true
	for hazard in hazard_nodes:
		var hazard_key := str(hazard.get_instance_id())
		var touching := ship_rect.intersects(hazard.get_rect())
		if touching and not active_hazard_contacts.has(hazard_key):
			active_hazard_contacts[hazard_key] = true
			state.apply_damage(25)
			changed = true
		elif not touching:
			active_hazard_contacts.erase(hazard_key)
	if state.hull <= 0:
		_finish_game(false)
	elif state.has_won():
		_finish_game(true)
	elif changed:
		_save_game()
		_publish_after_draw("")

func _finish_game(won: bool) -> void:
	loop_complete = won
	failed = not won
	screen_mode = "RESULT"
	state.paused = true
	result_title.text = "ROUTE COMPLETE" if won else "VOYAGE LOST"
	result_detail.text = "Three embers recovered. The route is secure." if won else "The hull was lost among the hazards."
	result_layer.visible = true
	pause_layer.visible = false
	# A resolved voyage can only be restarted or left for the menu; never offer a
	# stale pre-result autosave as a resumable session.
	if FileAccess.file_exists(SAVE_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(SAVE_PATH))
	_publish_after_draw("core-loop-complete" if won else "")

func _update_hud() -> void:
	ember_label.text = "EMBERS  %d / 3" % state.embers.size()
	hull_label.text = "HULL  %d%%" % state.hull
	var seconds := int(state.elapsed_seconds)
	time_label.text = "%02d:%02d" % [seconds / 60, seconds % 60]

func _save_game() -> void:
	if screen_mode == "MENU" or loop_complete or failed:
		return
	var snapshot := state.to_snapshot()
	snapshot["route_id"] = route_id
	snapshot["ship_position"] = [ship.position.x, ship.position.y]
	var output := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if output:
		output.store_string(JSON.stringify(snapshot))
		output.close()

func _read_valid_save() -> Dictionary:
	if not FileAccess.file_exists(SAVE_PATH):
		return {}
	var input := FileAccess.open(SAVE_PATH, FileAccess.READ)
	if input == null:
		return {}
	var decoded = JSON.parse_string(input.get_as_text())
	input.close()
	if typeof(decoded) != TYPE_DICTIONARY:
		return {}
	if decoded.get("route_id", "") != "aurora" or typeof(decoded.get("embers", null)) != TYPE_ARRAY:
		return {}
	if int(decoded.get("hull", -1)) < 1 or float(decoded.get("elapsed_seconds", -1.0)) < 0.0:
		return {}
	if not is_finite(float(decoded.get("elapsed_seconds", -1.0))):
		return {}
	if decoded["embers"].size() >= GameState.REQUIRED_EMBERS:
		return {}
	var unique_embers: Dictionary = {}
	for ember_id in decoded["embers"]:
		if not ["ember-west", "ember-mid", "ember-east"].has(ember_id):
			return {}
		if unique_embers.has(str(ember_id)):
			return {}
		unique_embers[str(ember_id)] = true
	var saved_position = decoded.get("ship_position", null)
	if typeof(saved_position) != TYPE_ARRAY or saved_position.size() != 2:
		return {}
	if not is_finite(float(saved_position[0])) or not is_finite(float(saved_position[1])):
		return {}
	return decoded

func _safe_vector(value: Variant) -> Vector2:
	if typeof(value) != TYPE_ARRAY or value.size() != 2:
		return Vector2(150, 355)
	return Vector2(clampf(float(value[0]), 34.0, 1198.0), clampf(float(value[1]), 126.0, 614.0))

func _button(text: String, position: Vector2, size: Vector2, handler: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.position = position
	button.size = size
	button.add_theme_font_size_override("font_size", 22)
	button.pressed.connect(handler)
	return button

func _label(text: String, position: Vector2, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text
	label.position = position
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	return label

func _generated_texture(asset_key: String) -> Texture2D:
	for extension in ["png", "jpg", "webp"]:
		var path := "res://assets/generated/%s.%s" % [asset_key, extension]
		if ResourceLoader.exists(path):
			var resource = load(path)
			if resource is Texture2D:
				return resource
	return null

func _apply_generated_art(parent: Control, asset_key: String) -> void:
	var texture := _generated_texture(asset_key)
	if texture == null:
		return
	var art := TextureRect.new()
	art.mouse_filter = Control.MOUSE_FILTER_IGNORE
	art.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	art.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	art.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	art.texture = texture
	parent.add_child(art)

func _publish_after_draw(checkpoint_id: String) -> void:
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	_publish_probe()
	if not checkpoint_id.is_empty():
		_emit_checkpoint(checkpoint_id)

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
	if output:
		output.store_line(marker)
		output.close()

func _publish_probe() -> void:
	var output_path := OS.get_environment("DEVILUDO_E2E_UI_PROBE_FILE")
	var nonce := OS.get_environment("DEVILUDO_E2E_SESSION_NONCE")
	if output_path.is_empty() or nonce.is_empty() or not is_inside_tree():
		return
	probe_sequence += 1
	var visible_blocking_layers := int(pause_layer.is_visible_in_tree()) + int(result_layer.is_visible_in_tree())
	var snapshot := {
		"schema": "deviludo.e2e-ui-probe", "sessionNonce": nonce,
		"pid": OS.get_process_id(), "sequence": probe_sequence, "sceneId": "ember-voyager-main",
		"state": {
			"screen_mode": screen_mode, "session_active": screen_mode != "MENU",
			"gameplay_input_enabled": screen_mode == "PLAYING", "blocking_layer_count": visible_blocking_layers,
			"paused": screen_mode == "PAUSED", "loop_complete": loop_complete, "failed": failed, "route_selected": screen_mode != "MENU"
		},
		"progress": {"embers": state.embers.size(), "hull": state.hull, "elapsed_seconds": state.elapsed_seconds, "ship_x": ship.position.x, "ship_y": ship.position.y, "loop": 1 if loop_complete else 0},
		"controls": [
			_control_probe("new-game", "NAVIGATION", new_game_button), _control_probe("continue-game", "NAVIGATION", continue_button),
			_control_probe("quit-game", "NAVIGATION", quit_button), _control_probe("route-map", "GAMEPLAY", game_layer),
			_control_probe("player-ship", "STATUS", ship),
			_control_probe("ember-counter", "STATUS", ember_label), _control_probe("hull-status", "STATUS", hull_label),
			_control_probe("resume-game", "OVERLAY", resume_button), _control_probe("save-main-menu", "OVERLAY", menu_button),
			_control_probe("restart-voyage", "OVERLAY", restart_button), _control_probe("result-main-menu", "OVERLAY", result_menu_button),
			_control_probe("result-message", "STATUS", result_title)
		]
	}
	var temporary_path := "%s.tmp.%d" % [output_path, OS.get_process_id()]
	var output := FileAccess.open(temporary_path, FileAccess.WRITE)
	if output == null:
		return
	output.store_string(JSON.stringify(snapshot))
	output.close()
	DirAccess.rename_absolute(temporary_path, output_path)

func _control_probe(id: String, scope: String, control: Control) -> Dictionary:
	var live := control != null and control.is_inside_tree() and control.get_viewport() == get_viewport()
	var visible := live and control.is_visible_in_tree()
	var disabled := bool(control.get("disabled")) if control is BaseButton else false
	var viewport_size := get_viewport_rect().size
	var valid_viewport := viewport_size.x > 0.0 and viewport_size.y > 0.0
	var root_rect := Rect2()
	if live and valid_viewport:
		root_rect = control.get_global_rect().intersection(Rect2(Vector2.ZERO, viewport_size))
		if root_rect.size.x > 0.0 and root_rect.size.y > 0.0:
			last_probe_rects[id] = root_rect
	elif last_probe_rects.has(id):
		root_rect = last_probe_rects[id]
	var scale := Vector2(1280.0 / viewport_size.x, 720.0 / viewport_size.y) if valid_viewport else Vector2.ZERO
	var text := ""
	if control is Label:
		text = (control as Label).text
	elif control is BaseButton:
		text = (control as BaseButton).text
	var actionable := control is BaseButton or control == game_layer
	var enabled := visible and valid_viewport and actionable and not disabled
	if scope == "GAMEPLAY":
		enabled = enabled and screen_mode == "PLAYING"
	return {"id": id, "scope": scope, "visible": visible, "enabled": enabled,
		"text": text,
		"rect": {"x": root_rect.position.x * scale.x, "y": root_rect.position.y * scale.y, "width": root_rect.size.x * scale.x, "height": root_rect.size.y * scale.y}}
