Feature: Entity Search
  As a Home Assistant user
  I want to search for entities by name or ID
  So that I can find and control my devices

  Scenario: Search entities by friendly name
    Given a Home Assistant instance with multiple entities
    When I search for "living"
    Then I should find entities with "living" in their friendly name
    And the results should include "light.living_room"

  Scenario: Search entities by entity ID
    Given a Home Assistant instance with multiple entities
    When I search for "kitchen"
    Then I should find entities with "kitchen" in their entity ID
    And the results should include "switch.kitchen"

  Scenario: Search is case insensitive
    Given a Home Assistant instance with multiple entities
    When I search for "BEDROOM"
    Then I should find entities matching "bedroom"
    And the results should include "light.bedroom"

  Scenario: Search returns multiple matches
    Given a Home Assistant instance with multiple entities
    When I search for "light"
    Then I should find all entities containing "light"
    And the result count should be 2

  Scenario: Search returns empty for no matches
    Given a Home Assistant instance with multiple entities
    When I search for "nonexistent"
    Then I should find no entities

  Scenario: Get entities by domain
    Given a Home Assistant instance with multiple entities
    When I get entities for domain "light"
    Then I should only get light entities
    And all entity IDs should start with "light."

  Scenario: Get entities for empty domain
    Given a Home Assistant instance with multiple entities
    When I get entities for domain "climate"
    Then I should find no entities
