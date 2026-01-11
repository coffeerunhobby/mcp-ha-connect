Feature: History Retrieval
  As a Home Assistant user
  I want to retrieve historical data for my entities
  So that I can analyze trends and patterns

  Scenario: Get entity history for last 24 hours
    Given an entity "sensor.temperature" with historical data
    When I get the history for the last 24 hours
    Then I should receive historical state changes
    And the history API should be called with the correct time range

  Scenario: Get entity history with custom time range
    Given an entity "sensor.temperature" with historical data
    When I get the history for the last 48 hours
    Then I should receive historical state changes
    And the time range should be 48 hours

  Scenario: Get empty history for entity
    Given an entity with no history
    When I get the history
    Then I should receive an empty history array

  Scenario: Get system log entries
    Given a Home Assistant system log
    When I get the system log
    Then I should receive logbook entries
    And each entry should have timestamp and entity information

  Scenario: Get system log filtered by entity
    Given a Home Assistant system log
    When I get the system log for entity "light.living_room"
    Then I should receive only entries for that entity
    And the entity filter should be applied

  Scenario: Get system log with custom time range
    Given a Home Assistant system log
    When I get the system log for the last 48 hours
    Then the logbook API should use the 48 hour time range
