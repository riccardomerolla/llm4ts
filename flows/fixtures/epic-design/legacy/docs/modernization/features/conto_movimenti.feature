Feature: Account movements

  Scenario: Filter movements by date range
    Given movements over three months
    When the customer picks the last 30 days
    Then only those movements are listed

  Scenario: Filter movements by amount
    Given movements of several amounts
    When the customer sets a minimum of 100 EUR
    Then smaller movements are hidden

  Scenario: Export movements to fax
    Given a list of movements
    When the customer asks for a fax
    Then the list is sent to the fax gateway
