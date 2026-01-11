Feature: Device Control
  As a Home Assistant user
  I want to control my smart home devices through the MCP server
  So that I can manage my home automation

  # Light Control
  Scenario: Turn on a light
    Given a light entity "light.living_room" that is "off"
    When I turn on the light
    Then the light service "turn_on" should be called
    And the target should be "light.living_room"

  Scenario: Turn on a light with brightness
    Given a light entity "light.bedroom"
    When I turn on the light with brightness 75%
    Then the light service "turn_on" should be called
    And the service data should include brightness_pct 75

  Scenario: Set light color temperature
    Given a light entity "light.kitchen"
    When I set the color temperature to 4000K
    Then the light service "turn_on" should be called
    And the service data should include color_temp_kelvin 4000

  Scenario: Set light RGB color
    Given a light entity "light.office"
    When I set the RGB color to red (255, 0, 0)
    Then the light service "turn_on" should be called
    And the service data should include rgb_color [255, 0, 0]

  # Climate Control
  Scenario: Set thermostat temperature
    Given a climate entity "climate.living_room"
    When I set the temperature to 22 degrees
    Then the climate service "set_temperature" should be called
    And the service data should include temperature 22

  Scenario: Set HVAC mode to heat
    Given a climate entity "climate.bedroom"
    When I set the HVAC mode to "heat"
    Then the climate service "set_hvac_mode" should be called
    And the service data should include hvac_mode "heat"

  Scenario: Set climate preset mode
    Given a climate entity "climate.office"
    When I set the preset mode to "eco"
    Then the climate service "set_preset_mode" should be called
    And the service data should include preset_mode "eco"

  # Media Player Control
  Scenario: Play media player
    Given a media player entity "media_player.living_room"
    When I play the media player
    Then the media_player service "media_play" should be called

  Scenario: Pause media player
    Given a media player entity "media_player.bedroom"
    When I pause the media player
    Then the media_player service "media_pause" should be called

  Scenario: Set media player volume
    Given a media player entity "media_player.kitchen"
    When I set the volume to 50%
    Then the media_player service "volume_set" should be called
    And the service data should include volume_level 0.5

  # Cover Control
  Scenario: Open a cover
    Given a cover entity "cover.garage_door"
    When I open the cover
    Then the cover service "open_cover" should be called

  Scenario: Close a cover
    Given a cover entity "cover.blinds"
    When I close the cover
    Then the cover service "close_cover" should be called

  Scenario: Set cover position
    Given a cover entity "cover.living_room_blinds"
    When I set the cover position to 50%
    Then the cover service "set_cover_position" should be called
    And the service data should include position 50

  # Fan Control
  Scenario: Turn on a fan
    Given a fan entity "fan.bedroom"
    When I turn on the fan
    Then the fan service "turn_on" should be called

  Scenario: Set fan speed
    Given a fan entity "fan.living_room"
    When I set the fan speed to 75%
    Then the fan service "set_percentage" should be called
    And the service data should include percentage 75

  Scenario: Toggle fan oscillation
    Given a fan entity "fan.office"
    When I enable oscillation
    Then the fan service "oscillate" should be called
    And the service data should include oscillating true
