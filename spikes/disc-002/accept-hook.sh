#!/bin/sh
# DISC-002 spike: auto-accept any elicitation from the "spike" server, proving AL1 is automatable.
cat > "$(dirname "$0")/hook-input.json"
printf '%s' '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"confirm":true}}}'
