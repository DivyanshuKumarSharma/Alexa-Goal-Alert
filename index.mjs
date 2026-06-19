import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import sinricProModule from "sinricpro";
import devicesModule from "sinricpro/devices";

const dynamodb = new DynamoDBClient({});
const FOOTBALL_DATA_URL = "https://api.football-data.org/v4/matches";
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const LIVE_STATUSES = new Set(["LIVE", "IN_PLAY", "PAUSED"]);
const ESPN_LIVE_STATES = new Set(["in"]);
const SinricPro = sinricProModule.default || sinricProModule;
const { SinricProContactSensor } = devicesModule;

export const handler = async (event = {}) => {
  if (event.forceSinricTest === true) {
    await triggerSinricContactSensor({
      id: "manual-test",
      matchId: "manual-test",
      message: "Manual Sinric contact sensor test from Lambda.",
    });
    return {
      forced: true,
      message: "Opened and closed the Sinric contact sensor.",
    };
  }

  const tableName = requiredEnv("STATE_TABLE_NAME");
  const scoreProvider = (process.env.SCORE_PROVIDER || "espn").toLowerCase();
  const competitionCode = process.env.COMPETITION_CODE || "WC";

  const scoreData = await fetchScoreData(scoreProvider, competitionCode);
  const currentGoals = scoreData.goals;

  console.log(
    JSON.stringify({
      message: "Fetched score data",
      scoreProvider,
      competitionCode,
      matchCount: scoreData.matchCount,
      liveMatchCount: scoreData.liveMatches.length,
      liveMatches: scoreData.liveMatches,
      currentGoalCount: currentGoals.length,
    }),
  );

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
  console.log(
    JSON.stringify({
      message: "Computed new goals",
      seenGoalCount: seenGoalIds.size,
      currentGoalCount: currentGoals.length,
      newGoalCount: newGoals.length,
      newGoals: newGoals.map((goal) => goal.message),
    }),
  );

  for (const goal of newGoals) {
    console.log(
      JSON.stringify({
        message: "Alerting new goal",
        goal,
      }),
    );
    await triggerSinricContactSensor(goal);
  }

  await saveState(tableName, currentGoals, seenGoalIds);

  return {
    alerted: newGoals.length,
    seenGoals: currentGoals.length,
    scoreProvider,
    newGoals: newGoals.map((goal) => goal.message),
  };
};

async function fetchScoreData(scoreProvider, competitionCode) {
  if (scoreProvider === "football-data") {
    const apiToken = requiredEnv("FOOTBALL_DATA_API_TOKEN");
    const matches = await fetchFootballDataMatches(apiToken, competitionCode);
    const liveMatches = matches.filter((match) => LIVE_STATUSES.has(match.status));

    return {
      matchCount: matches.length,
      liveMatches: liveMatches.map((match) => ({
        id: match.id,
        status: match.status,
        homeTeam: match.homeTeam?.name,
        awayTeam: match.awayTeam?.name,
        score: match.score,
        goalCount: (match.goals || []).length,
      })),
      goals: extractFootballDataLiveGoals(matches),
    };
  }

  const events = await fetchEspnEvents();
  const liveEvents = events.filter((event) => isEspnLiveEvent(event));

  return {
    matchCount: events.length,
    liveMatches: liveEvents.map((event) => espnMatchSummary(event)),
    goals: extractEspnLiveScorelineGoals(events),
  };
}

async function fetchFootballDataMatches(apiToken, competitionCode) {
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

async function fetchEspnEvents() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const response = await fetch(`${ESPN_SCOREBOARD_URL}?dates=${date}`, {
    headers: {
      "User-Agent": "alexa-goal-alert/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN scoreboard returned ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return body.events || [];
}

function extractFootballDataLiveGoals(matches) {
  const goals = [];

  for (const match of matches) {
    if (!LIVE_STATUSES.has(match.status)) {
      continue;
    }

    const home = match.homeTeam?.shortName || match.homeTeam?.name || "Home";
    const away = match.awayTeam?.shortName || match.awayTeam?.name || "Away";
    const matchId = String(match.id);
    const detailedGoals = match.goals || [];

    for (const goal of detailedGoals) {
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

    if (detailedGoals.length === 0) {
      const scoreline = getCurrentScoreline(match);

      if (scoreline && scoreline.home + scoreline.away > 0) {
        goals.push({
          id: `${matchId}:scoreline:${scoreline.home}-${scoreline.away}`,
          matchId,
          message: `Score update. ${home} ${scoreline.home}, ${away} ${scoreline.away}.`,
        });
      }
    }
  }

  return goals;
}

function extractEspnLiveScorelineGoals(events) {
  const goals = [];

  for (const event of events) {
    if (!isEspnLiveEvent(event)) {
      continue;
    }

    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const home = competitors.find((competitor) => competitor.homeAway === "home");
    const away = competitors.find((competitor) => competitor.homeAway === "away");
    const homeName = home?.team?.shortDisplayName || home?.team?.displayName || "Home";
    const awayName = away?.team?.shortDisplayName || away?.team?.displayName || "Away";
    const homeScore = Number.parseInt(home?.score || "0", 10);
    const awayScore = Number.parseInt(away?.score || "0", 10);

    if (homeScore + awayScore === 0) {
      continue;
    }

    goals.push({
      id: `${event.id}:espn-scoreline:${homeScore}-${awayScore}`,
      matchId: String(event.id),
      message: `Score update. ${homeName} ${homeScore}, ${awayName} ${awayScore}.`,
    });
  }

  return goals;
}

function isEspnLiveEvent(event) {
  const state = event.competitions?.[0]?.status?.type?.state;
  return ESPN_LIVE_STATES.has(state);
}

function espnMatchSummary(event) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  const details = competition?.details || [];

  return {
    id: event.id,
    status: competition?.status,
    homeTeam: home?.team?.displayName,
    awayTeam: away?.team?.displayName,
    score: {
      home: Number.parseInt(home?.score || "0", 10),
      away: Number.parseInt(away?.score || "0", 10),
    },
    goalCount: details.filter((detail) => detail.scoringPlay === true).length,
  };
}

function getCurrentScoreline(match) {
  const score = match.score || {};
  const candidates = [score.fullTime, score.regularTime, score.current];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate?.home) && Number.isFinite(candidate?.away)) {
      return {
        home: candidate.home,
        away: candidate.away,
      };
    }
  }

  return null;
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
  const holdOpenMs = Number(process.env.SINRIC_HOLD_OPEN_MS || "10000");

  const contactSensor = SinricPro.add(SinricProContactSensor(deviceId));
  await SinricPro.begin({ appKey, appSecret, debug: false });

  try {
    console.log(`Opening Sinric contact sensor for: ${goal.message}`);
    const openSent = await contactSensor.sendEvent("setContactState", { state: "open" });
    console.log(JSON.stringify({ message: "Sinric open event queued", openSent }));

    if (!openSent) {
      throw new Error("Sinric Pro SDK did not queue the contact sensor open event");
    }

    await sleep(holdOpenMs);
    const closeSent = await contactSensor.sendEvent("setContactState", { state: "closed" });
    console.log(JSON.stringify({ message: "Sinric close event queued", closeSent }));

    if (!closeSent) {
      throw new Error("Sinric Pro SDK did not queue the contact sensor close event");
    }

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
