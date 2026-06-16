import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import boto3


dynamodb = boto3.resource("dynamodb")

FOOTBALL_DATA_URL = "https://api.football-data.org/v4/matches"
LIVE_STATUSES = {"LIVE", "IN_PLAY", "PAUSED"}


def lambda_handler(event, context):
    table = dynamodb.Table(required_env("STATE_TABLE_NAME"))
    api_token = required_env("FOOTBALL_DATA_API_TOKEN")
    competition_code = os.environ.get("COMPETITION_CODE", "WC")
    alert_webhook_url = required_env("ALERT_WEBHOOK_URL")

    matches = fetch_matches(api_token, competition_code)
    current_goals = extract_live_goals(matches)

    state = load_state(table)
    seen_goal_ids = set(state.get("seen_goal_ids", []))
    initialized = state.get("initialized", False)

    if not initialized and not should_alert_existing_goals():
        save_state(table, current_goals, seen_goal_ids)
        return {
            "initialized": True,
            "alerted": 0,
            "seen_goals": len(current_goals),
        }

    new_goals = [goal for goal in current_goals if goal["id"] not in seen_goal_ids]

    for goal in new_goals:
        trigger_alert(alert_webhook_url, goal)

    save_state(table, current_goals, seen_goal_ids)

    return {
        "alerted": len(new_goals),
        "seen_goals": len(current_goals),
        "new_goals": [goal["message"] for goal in new_goals],
    }


def fetch_matches(api_token, competition_code):
    today = datetime.now(timezone.utc).date()
    params = {
        "competitions": competition_code,
        "dateFrom": (today - timedelta(days=1)).isoformat(),
        "dateTo": (today + timedelta(days=1)).isoformat(),
    }
    url = f"{FOOTBALL_DATA_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "X-Auth-Token": api_token,
            "X-Unfold-Goals": "true",
            "User-Agent": "alexa-goal-alert/1.0",
        },
    )

    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8")).get("matches", [])


def extract_live_goals(matches):
    goals = []

    for match in matches:
        if match.get("status") not in LIVE_STATUSES:
            continue

        home = match.get("homeTeam", {}).get("shortName") or match.get("homeTeam", {}).get("name", "Home")
        away = match.get("awayTeam", {}).get("shortName") or match.get("awayTeam", {}).get("name", "Away")
        match_id = str(match["id"])

        for goal in match.get("goals", []):
            score = goal.get("score") or {}
            scorer = (goal.get("scorer") or {}).get("name") or "Unknown scorer"
            team = (goal.get("team") or {}).get("name") or "Unknown team"
            minute = goal.get("minute")
            injury_time = goal.get("injuryTime")
            minute_text = format_minute(minute, injury_time)
            home_score = score.get("home", "?")
            away_score = score.get("away", "?")

            goals.append(
                {
                    "id": build_goal_id(match_id, goal),
                    "match_id": match_id,
                    "message": (
                        f"Goal for {team}. {scorer} scored at {minute_text}. "
                        f"{home} {home_score}, {away} {away_score}."
                    ),
                }
            )

    return goals


def build_goal_id(match_id, goal):
    score = goal.get("score") or {}
    scorer = goal.get("scorer") or {}
    team = goal.get("team") or {}
    return ":".join(
        [
            match_id,
            str(goal.get("minute")),
            str(goal.get("injuryTime")),
            str(team.get("id") or team.get("name")),
            str(scorer.get("id") or scorer.get("name")),
            str(score.get("home")),
            str(score.get("away")),
        ]
    )


def format_minute(minute, injury_time):
    if minute is None:
        return "an unknown minute"
    if injury_time:
        return f"{minute}+{injury_time} minutes"
    return f"{minute} minutes"


def trigger_alert(webhook_url, goal):
    payload = json.dumps(goal).encode("utf-8")
    method = os.environ.get("ALERT_WEBHOOK_METHOD", "POST").upper()

    if method == "GET":
        separator = "&" if "?" in webhook_url else "?"
        url = f"{webhook_url}{separator}{urllib.parse.urlencode({'message': goal['message']})}"
        request = urllib.request.Request(url, method="GET")
    else:
        request = urllib.request.Request(
            webhook_url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )

    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def load_state(table):
    response = table.get_item(Key={"id": "world-cup-goals"})
    item = response.get("Item", {})
    return {
        "initialized": item.get("initialized", False),
        "seen_goal_ids": item.get("seen_goal_ids", []),
    }


def save_state(table, goals, seen_goal_ids):
    goal_ids = {goal["id"] for goal in goals}
    goal_ids.update(seen_goal_ids)

    table.put_item(
        Item={
            "id": "world-cup-goals",
            "initialized": True,
            "seen_goal_ids": sorted(goal_ids),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )


def should_alert_existing_goals():
    return os.environ.get("ALERT_EXISTING_GOALS", "false").lower() in {"1", "true", "yes"}


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value
