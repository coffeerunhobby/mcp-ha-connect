Feature: State Retrieval
  As a Home Assistant user
  I want to retrieve entity states
  So that I can monitor my smart home devices

  Scenario: Get all entity states
    Given a Home Assistant with multiple entities
    When I get all states
    Then I should receive all entity states
    And the states API should be called

  Scenario: Get state of specific entity
    Given an entity "light.living_room" exists
    When I get the state of "light.living_room"
    Then I should receive the entity state
    And the state should include entity_id, state, and attributes

  Scenario: Get state of non-existent entity
    Given an entity does not exist
    When I get the state of "nonexistent.entity"
    Then I should receive null

  Scenario: Handle API error gracefully
    Given the API returns a 500 error
    When I get the state of "sensor.temperature"
    Then it should throw an API error

  Scenario: Get all sensors
    Given a Home Assistant with sensors and other entities
    When I get all sensors
    Then I should only receive sensor and binary_sensor entities
    And other entity types should be excluded

  Scenario: Get sensors when none exist
    Given a Home Assistant with no sensors
    When I get all sensors
    Then I should receive an empty array
