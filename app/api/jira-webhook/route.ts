/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET;
const PPCSHD_STATUS_URL = process.env.PPCSHD_STATUS_URL;

// klucze projektow Jira - zmieniasz tutaj
const PPCS_KEY = "PPCS"; // dawniej UT
const PPCSHD_KEY = "PPCSHD";

const processedWebhooks = new Map<string, number>();

function verifyJiraSignature(
  payload: string,
  signature: string | null,
): boolean {
  if (!JIRA_WEBHOOK_SECRET || !signature) {
    return false;
  }

  const receivedSignature = signature.replace("sha256=", "");

  const hmac = crypto.createHmac("sha256", JIRA_WEBHOOK_SECRET);
  hmac.update(payload);
  const expectedSignature = hmac.digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSignature),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
}

async function sendPpcshdStatus(data: object): Promise<void> {
  if (!PPCSHD_STATUS_URL) return;
  await fetch(PPCSHD_STATUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// PPCSHD: wysylka statusu zadania do zewnetrznego endpointu
async function handlePpcshd(payload: any) {
  const webhookEvent = payload.webhookEvent;
  if (
    webhookEvent !== "jira:issue_created" &&
    webhookEvent !== "jira:issue_updated"
  ) {
    return NextResponse.json(
      { message: "Not an issue create or update" },
      { status: 200 },
    );
  }

  const logData = {
    numerZadania: payload.issue.key,
    podsumowanie: payload.issue.fields.summary,
    opisZadania: payload.issue.fields.description,
    status: payload.issue.fields.status.name,

    zgloszonePrzez: payload.issue.fields.reporter.displayName,

    modul: payload.issue.fields.customfield_10189?.value || "-",

    kategorie: payload.issue.fields.issuetype.name,

    utworzono: payload.issue.fields.created,

    dataUzyskaniaPelnychInformacji:
      payload.issue.fields.customfield_10192 || null,

    priorytet: payload.issue.fields.priority.name,
    reactionTime: payload.issue.fields.customfield_10012 || null,
    odbiorcaRaportu: payload.issue.fields.customfield_10190?.[0]?.value || "-",

    statusWady: payload.issue.fields.customfield_10119?.value || "-",

    slaTimes: {
      firstResponseTime:
        payload.issue.fields.customfield_10066?.ongoingCycle?.breachTime
          ?.friendly || null,

      resolutionTime:
        payload.issue.fields.customfield_10065?.ongoingCycle?.breachTime
          ?.friendly || null,
    },

    statusChange: payload.changelog?.items?.[0] || null,
  };

  await sendPpcshdStatus(logData);

  return NextResponse.json(
    { message: { foo: `${PPCSHD_KEY} project`, data: payload } },
    { status: 200 },
  );
}

// PPCS: notyfikacja na Slacka przy przejsciu z dowolnego statusu -> To Do
async function handlePpcs(payload: any, webhookId: string) {
  const issue = payload.issue;

  console.log("[PPCS] start", {
    issueKey: issue?.key,
    webhookEvent: payload.webhookEvent,
    webhookId,
    currentStatus: issue?.fields?.status?.name,
    changelogItems: payload.changelog?.items,
    hasSlackUrl: !!SLACK_WEBHOOK_URL,
  });

  if (payload.webhookEvent !== "jira:issue_updated") {
    console.log("[PPCS] skip: nie issue_updated", payload.webhookEvent);
    return NextResponse.json(
      { message: "Not an issue update" },
      { status: 200 },
    );
  }

  const statusChange = payload.changelog?.items?.find(
    (item: { field: string }) => item.field === "status",
  );

  if (!statusChange) {
    console.log(
      "[PPCS] skip: brak zmiany statusu w changelogu",
      payload.changelog?.items?.map((i: { field: string }) => i.field),
    );
    return NextResponse.json({ message: "No status change" }, { status: 200 });
  }

  const fromStatus = statusChange.fromString;
  const toStatus = statusChange.toString;

  console.log("[PPCS] status", { fromStatus, toStatus, expected: "To Do" });

  if (toStatus !== "To Do") {
    console.log("[PPCS] skip: docelowy status != 'To Do'", toStatus);
    return NextResponse.json(
      {
        message: "Status change not matching criteria",
        from: fromStatus,
        to: toStatus,
        expected: "* → DO ZROBIENIA",
      },
      { status: 200 },
    );
  }

  processedWebhooks.set(webhookId, Date.now());

  if (!SLACK_WEBHOOK_URL) {
    console.error("[PPCS] brak SLACK_WEBHOOK_URL w env");
    return NextResponse.json(
      { error: "Slack webhook not configured" },
      { status: 500 },
    );
  }

  const slackMessage = {
    text: `✅ Zadanie gotowe do realizacji: ${issue.key}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "✅ Zadanie Gotowe do Realizacji",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Klucz:*\n${issue.key}`,
          },
          {
            type: "mrkdwn",
            text: `*Status:*\n${
              fromStatus === "In Review" ? "W trakcie weryfikacji" : fromStatus
            } → ${toStatus === "To Do" ? "Do zrobienia" : toStatus}`,
          },
          {
            type: "mrkdwn",
            text: `*Tytuł:*\n${issue.fields.summary}`,
          },
          {
            type: "mrkdwn",
            text: `*Reporter:*\n${issue.fields.reporter.displayName}`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Zobacz w Jira",
              emoji: true,
            },
            url: `${payload.issue.self.split("/rest/api")[0]}/browse/${issue.key}`,
            style: "primary",
          },
        ],
      },
    ],
  };

  console.log("[PPCS] wysylam na Slacka", issue.key);

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackMessage),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[PPCS] Slack odrzucil", response.status, errorText);
    return NextResponse.json(
      {
        error: "Failed to send to Slack",
        status: response.status,
        details: errorText,
      },
      { status: 500 },
    );
  }

  console.log("[PPCS] wyslano na Slacka", issue.key);

  return NextResponse.json(
    {
      message: "Notification sent to Slack",
      issue: issue.key,
      transition: `${fromStatus} → ${toStatus}`,
    },
    { status: 200 },
  );
}

export async function POST(request: NextRequest) {
  try {
    if (!JIRA_WEBHOOK_SECRET) {
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    const signature =
      request.headers.get("x-hub-signature") ||
      request.headers.get("x-atlassian-webhook-identifier");
    const rawBody = await request.text();

    if (!verifyJiraSignature(rawBody, signature)) {
      console.error("[jira-webhook] zly podpis, hasSignature:", !!signature);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    const webhookId = `${payload.issue?.key}_${payload.changelog?.id}_${payload.timestamp}`;

    if (processedWebhooks.has(webhookId)) {
      console.log("[jira-webhook] skip: duplikat", webhookId);
      return NextResponse.json(
        { message: "Duplicate webhook" },
        { status: 200 },
      );
    }

    const projectKey = payload.issue?.fields?.project?.key;

    console.log("[jira-webhook] routing", {
      projectKey,
      webhookEvent: payload.webhookEvent,
      issueKey: payload.issue?.key,
      webhookId,
      matches: { PPCSHD_KEY, PPCS_KEY },
    });

    if (projectKey === PPCSHD_KEY) return handlePpcshd(payload);
    if (projectKey === PPCS_KEY) return handlePpcs(payload, webhookId);

    console.log("[jira-webhook] skip: nieobslugiwany projekt", projectKey);
    return NextResponse.json(
      { message: `Not ${PPCS_KEY} project` },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

