import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import sinricProModule from "sinricpro";
import devicesModule from "sinricpro/devices";

const dynamodb = new DynamoDBClient({});
const FOOTBALL_DATA_URL = "https://api.football-data.org/v4/matches";
const LIVE_STATUSES = new Set(["LIVE", "IN_PLAY", "PAUSED"]);
const SinricPro = sinricProModule.default || sinricProModule;
const { SinricProContactSensor } = devicesModule;

export const handler = async () => {
  const tableName = requiredEnv("STATE_TABLE_NAME");
  const apiToken = requiredEnv("FOOTBALL_DATA_API_TOKEN");
  const competitionCode = process.env.COMPETITION_CODE || "WC";

  const matches = await fetchMatches(apiToken, competitionCode);
  const currentGoals = extractLiveGoals(matches);

  const state = await loadState(tableName);
  const seenGoalIds = new Set(state.seenGoalIds);

  if (!state.initialized && !shouldAlertExistingGoals()) {
    await saveState(tableName, currentGoals, seenGoalIds);
    return {
      initialized: true,
      alerted: 0,
      seenGoals: currentGoals.length,
    };
  }

  const newGoals = currentGoals.filter((goal) => !seenGoalIds.has(goal.id));

  for (const goal of newGoals) {
    await triggerSinricContactSensor(goal);
  }

  await saveState(tableName, currentGoals, seenGoalIds);

  return {
    alerted: newGoals.length,
    seenGoals: currentGoals.length,
    newGoals: newGoals.map((goal) => goal.message),
  };
};

async function fetchMatches(apiToken, competitionCode) {
  const today = new Date();
  const dateFrom = addDays(today, -1).toISOString().slice(0, 10);
  const dateTo = addDays(today, 1).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    competitions: competitionCode,
    dateFrom,
    dateTo,
  });

  const response = await fetch(`${FOOTBALL_DATA_URL}?${params}`, {
    headers: {
      "X-Auth-Token": apiToken,
      "X-Unfold-Goals": "true",
      "User-Agent": "alexa-goal-alert/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`football-data.org returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return body.matches || [];
}

function extractLiveGoals(matches) {
  const goals = [];

  for (const match of matches) {
    if (!LIVE_STATUSES.has(match.status)) {
      continue;
    }

    const home = match.homeTeam?.shortName || match.homeTeam?.name || "Home";
    const away = match.awayTeam?.shortName || match.awayTeam?.name || "Away";
    const matchId = String(match.id);

    for (const goal of match.goals || []) {
      const score = goal.score || {};
      const scorer = goal.scorer?.name || "Unknown scorer";
      const team = goal.team?.name || "Unknown team";
      const minuteText = formatMinute(goal.minute, goal.injuryTime);
      const homeScore = score.home ?? "?";
      const awayScore = score.away ?? "?";

      goals.push({
        id: buildGoalId(matchId, goal),
        matchId,
        message: `Goal for ${team}. ${scorer} scored at ${minuteText}. ${home} ${homeScore}, ${away} ${awayScore}.`,
      });
    }
  }

  return goals;
}

function buildGoalId(matchId, goal) {
  const score = goal.score || {};
  const scorer = goal.scorer || {};
  const team = goal.team || {};

  return [
    matchId,
    goal.minute,
    goal.injuryTime,
    team.id || team.name,
    scorer.id || scorer.name,
    score.home,
    score.away,
  ].join(":");
}

function formatMinute(minute, injuryTime) {
  if (minute == null) {
    return "an unknown minute";
  }
  if (injuryTime) {
    return `${minute}+${injuryTime} minutes`;
  }
  return `${minute} minutes`;
}

async function triggerSinricContactSensor(goal) {
  const appKey = requiredEnv("SINRIC_APP_KEY");
  const appSecret = requiredEnv("SINRIC_APP_SECRET");
  const deviceId = requiredEnv("SINRIC_DEVICE_ID");
  const holdOpenMs = Number(process.env.SINRIC_HOLD_OPEN_MS || "5000");

  const contactSensor = SinricPro.add(SinricProContactSensor(deviceId));
  await SinricPro.begin({ appKey, appSecret, debug: false });

  try {
    console.log(`Opening Sinric contact sensor for: ${goal.message}`);
    await contactSensor.sendEvent("setContactState", { state: "open" });
    await sleep(holdOpenMs);
    await contactSensor.sendEvent("setContactState", { state: "closed" });
    await sleep(1000);
  } finally {
    await SinricPro.stop();
  }
}

async function loadState(tableName) {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        id: { S: "world-cup-goals" },
      },
    }),
  );

  const item = response.Item || {};
  const seenGoalIdsJson = item.seen_goal_ids_json?.S || "[]";

  return {
    initialized: item.initialized?.BOOL || false,
    seenGoalIds: JSON.parse(seenGoalIdsJson),
  };
}

async function saveState(tableName, goals, seenGoalIds) {
  const goalIds = new Set(goals.map((goal) => goal.id));

  for (const goalId of seenGoalIds) {
    goalIds.add(goalId);
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        id: { S: "world-cup-goals" },
        initialized: { BOOL: true },
        seen_goal_ids_json: { S: JSON.stringify([...goalIds].sort()) },
        updated_at: { S: new Date().toISOString() },
      },
    }),
  );
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAlertExistingGoals() {
  return ["1", "true", "yes"].includes((process.env.ALERT_EXISTING_GOALS || "false").toLowerCase());
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
