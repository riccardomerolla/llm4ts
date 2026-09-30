Feature: Balance inquiry

  Scenario: Show the available balance
    Given a customer with one current account
    When they open the account
    Then the available balance is shown in EUR

  Scenario: Session timeout warning
    Given a customer idle for 13 minutes
    Then a warning offers to extend the session
