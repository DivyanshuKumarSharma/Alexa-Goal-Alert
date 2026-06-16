# Alexa Goal Alert

This project checks for live FIFA World Cup goals every five minutes. When it finds a new goal, AWS Lambda opens a Sinric Pro contact sensor. Alexa sees that contact sensor open and runs a routine on the bedroom Echo Dot.

## Pipeline

```text
EventBridge Scheduler, every 5 minutes
  -> AWS Lambda, Node.js
  -> football-data.org /v4/matches
  -> DynamoDB state table, prevents duplicate alerts
  -> Sinric Pro contact sensor opens
  -> Alexa Routine triggers
  -> Bedroom Echo Dot plays sound
  -> Sinric Pro contact sensor closes again
```

The alert can be delayed by up to about five minutes because the schedule polls every five minutes.

## Why Sinric Pro

Alexa does not let arbitrary Lambda code directly make an Echo Dot play audio. The workaround is to use an Alexa Routine triggered by a smart-home device event.

Voice Monkey was not available in Canada, so this setup uses **Sinric Pro**:

1. Create a Sinric Pro **Contact Sensor**.
2. Link the Sinric Pro Alexa skill.
3. Ask Alexa to discover devices.
4. Use that discovered contact sensor as the Alexa Routine trigger.

## Sinric Pro Setup

1. Create a Sinric Pro account.
2. Create a new device.
3. Choose device type: `Contact Sensor`.
4. Leave `Restore Device State When Connect` off.
5. Skip `Custom Settings`.
6. Save the device.
7. Copy these values privately:
   - `Device ID`
   - `App Key`
   - `App Secret`

Do not commit or paste these secrets publicly.

## Alexa Routine Setup

In the Alexa app:

1. Link the Sinric Pro skill.
2. Ask: `Alexa, discover devices`.
3. Go to `More -> Routines -> +`.
4. Name the routine: `World Cup Goal Alert`.
5. For `When this happens`, choose `Smart Home`.
6. Select the Sinric Pro contact sensor.
7. Choose the contact sensor `Opens` event.
8. For `Alexa Will`, choose the sound, phrase, announcement, or music you want.
9. Under `Hear Alexa From`, select the bedroom Echo Dot.
10. Save the routine.

To change the Echo Dot noise later, edit only the routine's `Alexa Will` action. Keep the `When this happens` trigger unchanged.

## football-data.org Setup

This project uses football-data.org and asks for expanded goal data using the `X-Unfold-Goals` header.

1. Create a football-data.org API token.
2. Keep the token private.
3. Use `CompetitionCode=WC` for the World Cup.

## AWS Setup

Install these on Windows:

1. AWS CLI v2
2. AWS SAM CLI
3. Node.js/npm

Open a new PowerShell window and verify:

```powershell
aws --version
sam --version
npm --version
```

Configure AWS credentials:

```powershell
aws configure
```

The deployment used this region:

```text
ap-southeast-1
```

That is AWS Asia Pacific (Singapore). Mumbai would be `ap-south-1`.

Verify the configured account:

```powershell
aws sts get-caller-identity
```

## Deploy

From this project folder:

```powershell
cd "C:\Users\User 1\Documents\Alexa Goal Alert"
npm install
sam validate
sam build
```

Deploy with SAM. Use fresh private values for the tokens and secrets:

```powershell
sam deploy --stack-name alexa-goal-alert --region ap-southeast-1 --resolve-s3 --capabilities CAPABILITY_IAM --parameter-overrides FootballDataApiToken=YOUR_FOOTBALL_DATA_TOKEN SinricAppKey=YOUR_SINRIC_APP_KEY SinricAppSecret=YOUR_SINRIC_APP_SECRET SinricDeviceId=YOUR_SINRIC_DEVICE_ID CompetitionCode=WC
```

`--resolve-s3` lets SAM create/manage the deployment bucket automatically.

If using `sam deploy --guided`, enter only the raw value at each parameter prompt. Do not type `FootballDataApiToken=...` at the prompt. Also choose `N` when asked whether to save arguments to a config file, because the arguments contain secrets.

Successful deployment prints:

```text
Successfully created/updated stack - alexa-goal-alert in ap-southeast-1
```

## Test

In AWS Console, region `ap-southeast-1`:

1. Open `Lambda`.
2. Open the deployed goal alert function.
3. Click `Test`.
4. Create a private test event named `manual-test`.
5. Use this JSON:

```json
{}
```

If there is no live World Cup goal, a successful response looks like:

```json
{
  "alerted": 0,
  "seenGoals": 0,
  "newGoals": []
}
```

Then verify the schedule:

1. Open `EventBridge Scheduler`.
2. Open `GoalAlertFunctionEveryFiveMinutes`.
3. Confirm `Status` is `Enabled`.
4. Confirm the schedule is `rate (5 minutes)`.
5. Confirm the target is the goal alert Lambda function.

## What Happens On A Goal

If a goal is scored in a live World Cup match:

1. EventBridge runs Lambda on the next five-minute tick.
2. Lambda checks football-data.org.
3. Lambda detects the new goal.
4. DynamoDB records the goal ID so it does not alert twice.
5. Lambda opens the Sinric Pro contact sensor.
6. Alexa sees the contact sensor open.
7. The Alexa Routine plays the chosen sound on the bedroom Echo Dot.
8. Lambda waits five seconds.
9. Lambda closes the contact sensor so the next goal can trigger again.

## First Run Behavior

By default, the first run records any already-visible goals without alerting. This avoids noisy alerts if the deployment starts during a match that already has goals.

To alert on already-visible live goals during the first run, set:

```text
ALERT_EXISTING_GOALS=true
```

## Security Note

If any API token, AWS key, or Sinric secret is pasted into chat, email, screenshots, or source control, rotate it.

After rotating a Sinric or football-data secret, update it in:

```text
Lambda -> function -> Configuration -> Environment variables
```

Relevant environment variables:

```text
FOOTBALL_DATA_API_TOKEN
SINRIC_APP_KEY
SINRIC_APP_SECRET
SINRIC_DEVICE_ID
SINRIC_HOLD_OPEN_MS
COMPETITION_CODE
STATE_TABLE_NAME
ALERT_EXISTING_GOALS
```

## Manual Console Fallback

SAM is the preferred path. If needed, the manual AWS Console equivalent is:

1. Create DynamoDB table with string partition key `id`.
2. Create a Node.js Lambda using `index.handler`.
3. Upload a zip containing `index.mjs`, `package.json`, `package-lock.json`, and `node_modules`.
4. Add the environment variables above.
5. Give the Lambda role `dynamodb:GetItem` and `dynamodb:PutItem` on the table.
6. Create an EventBridge Scheduler rule with `rate(5 minutes)` targeting the Lambda.
