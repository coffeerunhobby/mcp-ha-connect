Feature: Automation Management
  As a Home Assistant user
  I want to manage my automations
  So that I can control when and how my smart home responds to events

  Scenario: List all automations
    Given a Home Assistant with automations
    When I list all automations
    Then I should get all automation entities
    And each automation should have id, alias, and state

  Scenario: Get automation details
    Given an automation "automation.morning_lights" exists
    When I get the automation details
    Then I should see the automation alias "Morning Lights"
    And the state should be "on"
    And the mode should be "single"

  Scenario: Trigger an automation manually
    Given an automation "automation.morning_lights" exists
    When I trigger the automation
    Then the automation.trigger service should be called
    And the target should be "automation.morning_lights"

  Scenario: Trigger automation with variables
    Given an automation "automation.dynamic_scene" exists
    When I trigger the automation with variables {"brightness": 100}
    Then the automation.trigger service should be called
    And the variables should be passed

  Scenario: Enable a disabled automation
    Given a disabled automation "automation.night_mode" exists
    When I enable the automation
    Then the automation.turn_on service should be called

  Scenario: Disable an enabled automation
    Given an enabled automation "automation.morning_lights" exists
    When I disable the automation
    Then the automation.turn_off service should be called

  Scenario: Toggle automation state
    Given an automation "automation.morning_lights" exists
    When I toggle the automation
    Then the automation.toggle service should be called

  Scenario: Reload automations from configuration
    Given a Home Assistant with automations
    When I reload automations
    Then the automation.reload service should be called

  Scenario: Delete an automation
    Given an automation with ID "1234567890" exists
    When I delete the automation
    Then a DELETE request should be made to the config API
