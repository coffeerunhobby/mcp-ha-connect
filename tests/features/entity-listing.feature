Feature: Entity Listing
  As a Home Assistant user
  I want to list and filter entities
  So that I can get an overview of my smart home devices

  Scenario: List all entities without filters
    Given a Home Assistant instance with multiple entities
    When I list all entities
    Then I should get all 4 entities

  Scenario: Filter entities by domain
    Given a Home Assistant instance with multiple entities
    When I list entities filtered by domain "light"
    Then I should only get light entities
    And the count should be 2

  Scenario: Filter entities by state
    Given a Home Assistant instance with multiple entities
    When I list entities filtered by state "on"
    Then I should only get entities that are "on"
    And the count should be 2

  Scenario: Filter entities by search query
    Given a Home Assistant instance with multiple entities
    When I list entities filtered by search "room"
    Then I should only get entities matching "room"
    And the count should be 2

  Scenario: Apply limit to entity list
    Given a Home Assistant instance with multiple entities
    When I list entities with limit 2
    Then I should get at most 2 entities

  Scenario: Combine multiple filters
    Given a Home Assistant instance with multiple entities
    When I list entities filtered by domain "light" and state "on"
    Then I should only get lights that are on
    And the count should be 1

  Scenario: Get domain summary
    Given a Home Assistant instance with multiple entities
    When I get the summary for domain "light"
    Then the summary should show domain "light"
    And the total count should be 2
    And the state breakdown should show 1 "on" and 1 "off"

  Scenario: Get domain summary for non-existent domain
    Given a Home Assistant instance with multiple entities
    When I get the summary for domain "vacuum"
    Then the summary should show domain "vacuum"
    And the total count should be 0
