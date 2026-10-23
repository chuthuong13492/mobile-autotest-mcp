## Summary
Changes how card payments are authorized and stored.

## Requirements
1. Card payment authorization must reject an expired card and must never store the full card number.

## Acceptance criteria
- AC: Given an expired card, authorization returns "card_expired".
- AC: The stored record contains only the last 4 digits.
