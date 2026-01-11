Feature: Send Notifications
  As a Home Assistant user
  I want to send notifications to my mobile devices
  So that I can be alerted about important events

  Scenario: Send a simple notification
    Given a notification message "Hello from MCP!"
    When I send the notification to "mobile_app_samsung_s25_fe"
    Then the notification should be sent successfully
    And the service called should be "notify.mobile_app_samsung_s25_fe"

  Scenario: Send notification with title
    Given a notification message "Motion detected in garage"
    And a notification title "Security Alert"
    When I send the notification to "mobile_app_samsung_s25_fe"
    Then the notification should be sent successfully
    And the title should be included in the service data

  Scenario: Send notification with action buttons
    Given a notification message "Someone is at the door"
    And an action button "OPEN" with title "Open Door"
    And an action button "IGNORE" with title "Ignore"
    When I send the notification to "mobile_app_samsung_s25_fe"
    Then the notification should be sent successfully
    And the notification data should contain 2 actions

  Scenario: Send persistent notification (no target)
    Given a notification message "System update available"
    When I send the notification without a target
    Then the notification should be sent to "persistent_notification"

  Scenario: Send high priority notification
    Given a notification message "Water leak detected!"
    And priority set to "high"
    When I send the notification to "mobile_app_samsung_s25_fe"
    Then the notification should be sent successfully
    And the notification data should have priority "high"
