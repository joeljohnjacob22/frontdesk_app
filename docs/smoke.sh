#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING server: BASE=http://localhost:3000 bash docs/smoke.sh
# It walks one ticket through the whole lifecycle and checks the private-note rule from the outside.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
PASSWORD="${SEED_PASSWORD:-frontdesk-demo}"
AGENT_JAR="$(mktemp)"
CUSTOMER_JAR="$(mktemp)"
trap 'rm -f "$AGENT_JAR" "$CUSTOMER_JAR"' EXIT
SECRET="SECRET-NOTE-$RANDOM$RANDOM"

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=eval("j."+process.argv[1]);console.log(v)})' "$1"; }
post() { curl -s -b "$AGENT_JAR" -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

echo "1. anonymous ticket creation is refused"
ANONYMOUS_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/customer/tickets" \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Anonymous attempt","body":"Must be rejected","priority":"high"}')
[ "$ANONYMOUS_STATUS" = "401" ]
echo "   anonymous request refused: $ANONYMOUS_STATUS"

echo "2. a customer signs in and raises a ticket"
curl -s -c "$CUSTOMER_JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"customer@arvo.test\",\"password\":\"$PASSWORD\"}" >/dev/null
CREATED=$(curl -s -b "$CUSTOMER_JAR" -X POST "$BASE/api/customer/tickets" -H 'Content-Type: application/json' \
  -d '{"subject":"Smoke test","body":"Hello from curl","priority":"high"}')
ID=$(echo "$CREATED" | jget ticket.id)
echo "   ticket $(echo "$CREATED" | jget ticket.ticketNo)"

echo "3. an agent signs in and finds it"
curl -s -c "$AGENT_JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"anil@arvo.test\",\"password\":\"$PASSWORD\"}" >/dev/null
curl -s -b "$AGENT_JAR" "$BASE/api/agent/tickets?view=unclaimed" | grep -q "\"id\":$ID"
echo "   internal id $ID"

echo "4. claim it (a second claim must be refused)"
post "/api/agent/tickets/$ID/claim" '{}' | jget ticket.status
CODE=$(post "/api/agent/tickets/$ID/claim" '{}' | jget error.code)
[ "$CODE" = "already_claimed" ] && echo "   second claim refused: $CODE"

echo "5. private team note, then a public reply that waits on the customer"
post "/api/agent/tickets/$ID/notes" "{\"body\":\"$SECRET\"}" >/dev/null
post "/api/agent/tickets/$ID/replies" '{"body":"Can you tell us your username?","setWaiting":true}' | jget ticket.status

echo "6. what the CUSTOMER sees"
VIEW=$(curl -s -b "$CUSTOMER_JAR" "$BASE/api/customer/tickets/$ID")
echo "   status: $(echo "$VIEW" | jget status), messages: $(echo "$VIEW" | jget messages.length)"
if echo "$VIEW" | grep -q "$SECRET"; then echo "FAIL: the private note reached the customer"; exit 1; fi
echo "   PASS: the private note is not in the customer view"

echo "7. what the agent LIST shows (must contain no message text)"
LIST=$(curl -s -b "$AGENT_JAR" "$BASE/api/agent/tickets?view=all")
if echo "$LIST" | grep -q -e "$SECRET" -e "Hello from curl"; then echo "FAIL: message text in the list"; exit 1; fi
echo "   PASS: no message text in the list"

echo "8. customer answers, then the agent resolves"
post_c() { curl -s -b "$CUSTOMER_JAR" -X POST "$BASE/api/customer/tickets/$ID/messages" -H 'Content-Type: application/json' -d "$1"; }
echo "   outcome: $(post_c '{"body":"It is smoke.user"}' | jget outcome)"
post "/api/agent/tickets/$ID/resolve" '{}' | jget ticket.status
echo "   customer can now reopen: $(curl -s -b "$CUSTOMER_JAR" "$BASE/api/customer/tickets/$ID" | jget canReopen)"
echo "ALL SMOKE CHECKS PASSED"
