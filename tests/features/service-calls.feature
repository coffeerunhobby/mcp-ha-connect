Feature: Service Calls
  As a Home Assistant user
  I want to call Home Assistant services
  So that I can control my devices

  Scenario: Call service with domain and service name
    Given a Home Assistant connection
    When I call service "light.turn_on"
    Then the service should be called successfully
    And the request should go to "/services/light/turn_on"

  Scenario: Call service with target entity
    Given a Home Assistant connection
    When I call service "light.turn_on" targeting "light.living_room"
    Then the entity_id should be included in the request

  Scenario: Call service with service data
    Given a Home Assistant connection
    When I call service "light.turn_on" with brightness 255
    Then the brightness should be included in the request

  Scenario: Call service targeting multiple entities
    Given a Home Assistant connection
    When I call service "light.turn_off" targeting multiple entities
    Then all entity IDs should be included in the request

  Scenario: Call climate service with temperature
    Given a Home Assistant connection
    When I call service "climate.set_temperature" with temperature 22
    Then the temperature should be included in the request

  Scenario: Restart Home Assistant server
    Given a Home Assistant connection
    When I call the restart server operation
    Then the homeassistant.restart service should be called
