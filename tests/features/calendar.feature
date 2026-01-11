Feature: Calendar Operations
  As a Home Assistant user
  I want to access my calendar events
  So that I can see upcoming appointments and reminders

  Scenario: List all calendars
    Given a Home Assistant with calendar entities
    When I list all calendars
    Then I should see all calendar entities
    And each calendar should have entity_id, name, and state

  Scenario: Get events from a specific calendar
    Given a calendar "calendar.family" with events
    When I get events from "calendar.family"
    Then I should receive calendar events
    And each event should have summary and start date

  Scenario: Get events with custom date range
    Given a calendar "calendar.work" with events
    When I get events from January 1 to January 31
    Then the events should be within the date range

  Scenario: Get events using days parameter
    Given a calendar "calendar.reminders" with events
    When I get events for the next 7 days
    Then the end date should be 7 days from now

  Scenario: Get events from all calendars
    Given multiple calendars with events
    When I get events without specifying a calendar
    Then I should receive events from all calendars
    And results should be grouped by calendar

  Scenario: Get events from calendar with no events
    Given a calendar "calendar.empty" with no events
    When I get events from "calendar.empty"
    Then I should receive an empty events list
