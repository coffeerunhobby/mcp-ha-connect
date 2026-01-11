Feature: Automation Creation
  As a Home Assistant user
  I want to create automations via the MCP server
  So that I can automate my smart home devices

  Background:
    Given a connected Home Assistant client

  Scenario: Create a simple time-based automation
    Given an automation config with alias "Morning Lights"
    And a time trigger at "06:00:00"
    And an action to turn on "light.bedroom"
    When I create the automation
    Then the automation should be created successfully
    And the automation ID should be returned

  Scenario: Create an automation with state trigger
    Given an automation config with alias "Motion Alert"
    And a state trigger for "binary_sensor.motion" changing to "on"
    And an action to send notification "Motion detected!"
    When I create the automation
    Then the automation should be created successfully

  Scenario: Reject automation without required fields
    Given an automation config without alias
    When I attempt to create the automation
    Then it should fail with error "alias, trigger, and action are required"

  Scenario: Create automation with multiple actions
    Given an automation config with alias "Goodnight Routine"
    And a time trigger at "23:00:00"
    And an action to turn off "light.living_room"
    And an action to turn off "light.kitchen"
    And an action to set "climate.thermostat" to 18 degrees
    When I create the automation
    Then the automation should be created successfully
