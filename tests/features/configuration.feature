Feature: Server Configuration
  As an MCP server administrator
  I want to configure the server with my Home Assistant details
  So that I can connect to my smart home

  Scenario: Load valid configuration
    Given environment variables with HA_URL and HA_TOKEN
    When I load the configuration
    Then the configuration should be valid
    And baseUrl should be set correctly
    And token should be set correctly

  Scenario: Apply default values for optional settings
    Given only required environment variables
    When I load the configuration
    Then strictSsl should default to true
    And timeout should default to 30000
    And logLevel should default to "info"
    And logFormat should default to "plain"

  Scenario: Remove trailing slash from URL
    Given HA_URL with trailing slash "http://ha.local:8123/"
    When I load the configuration
    Then baseUrl should not have a trailing slash

  Scenario: Reject missing HA_URL
    Given environment variables without HA_URL
    When I attempt to load the configuration
    Then it should throw an error about invalid configuration

  Scenario: Reject missing HA_TOKEN
    Given environment variables without HA_TOKEN
    When I attempt to load the configuration
    Then it should throw an error about invalid configuration

  Scenario: Reject invalid URL format
    Given HA_URL with invalid format "not-a-url"
    When I attempt to load the configuration
    Then it should throw an error about invalid configuration

  Scenario: Parse HTTP server configuration
    Given HTTP mode is enabled
    When I load the configuration
    Then useHttp should be true
    And httpPort should be set

  Scenario: Validate bind address format
    Given an invalid bind address "invalid-ip"
    When I attempt to load the configuration
    Then it should throw an error about invalid bind address

  Scenario: Accept valid IPv4 bind address
    Given a valid IPv4 bind address "192.168.1.100"
    When I load the configuration
    Then httpBindAddr should be "192.168.1.100"

  Scenario: Accept valid IPv6 bind address
    Given a valid IPv6 bind address "::1"
    When I load the configuration
    Then httpBindAddr should be "::1"

  Scenario: Handle wildcard in allowed origins
    Given allowed origins set to "*"
    When I load the configuration
    Then httpAllowedOrigins should be an empty array

  Scenario: Parse comma-separated allowed origins
    Given allowed origins "http://localhost:3000,http://192.168.1.100"
    When I load the configuration
    Then httpAllowedOrigins should contain both origins
