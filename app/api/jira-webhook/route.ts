import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET;

const processedWebhooks = new Map<string, number>();
const CACHE_DURATION = 60000;

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedWebhooks.entries()) {
    if (now - timestamp > CACHE_DURATION) {
      processedWebhooks.delete(key);
    }
  }
}, 30000);

function verifyJiraSignature(payload: string, signature: string | null): boolean {
  if (!JIRA_WEBHOOK_SECRET || !signature) {
    return false;
  }

  const receivedSignature = signature.replace('sha256=', '');

  const hmac = crypto.createHmac('sha256', JIRA_WEBHOOK_SECRET);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!JIRA_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    const signature =
      request.headers.get('x-hub-signature') ||
      request.headers.get('x-atlassian-webhook-identifier');
    const rawBody = await request.text();

    if (!verifyJiraSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    const webhookId = `${payload.issue?.key}_${payload.changelog?.id}_${payload.timestamp}`;

    if (processedWebhooks.has(webhookId)) {
      return NextResponse.json({ message: 'Duplicate webhook' }, { status: 200 });
    }

    const webhookEvent = payload.webhookEvent;
    const issue = payload.issue;

    if (webhookEvent !== 'jira:issue_updated') {
      return NextResponse.json({ message: 'Not an issue update' }, { status: 200 });
    }

    const projectKey = issue?.fields?.project?.key;
    if (projectKey !== 'UT') {
      return NextResponse.json({ message: 'Not UT project' }, { status: 200 });
    }

    const changelog = payload.changelog;
    const statusChange = changelog?.items?.find(
      (item: { field: string }) => item.field === 'status'
    );

    if (!statusChange) {
      return NextResponse.json({ message: 'No status change' }, { status: 200 });
    }

    const fromStatus = statusChange.fromString;
    const toStatus = statusChange.toString;

    if (fromStatus === 'In Review' && toStatus === 'To Do') {
      processedWebhooks.set(webhookId, Date.now());

      if (!SLACK_WEBHOOK_URL) {
        return NextResponse.json({ error: 'Slack webhook not configured' }, { status: 500 });
      }

      const slackMessage = {
        text: `✅ Zadanie gotowe do realizacji: ${issue.key}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '✅ Zadanie Gotowe do Realizacji',
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Klucz:*\n${issue.key}`,
              },
              {
                type: 'mrkdwn',
                text: `*Status:*\n${
                  fromStatus === 'In Review' ? 'W trakcie weryfikacji' : fromStatus
                } → ${toStatus === 'To Do' ? 'Do zrobienia' : toStatus}`,
              },
              {
                type: 'mrkdwn',
                text: `*Tytuł:*\n${issue.fields.summary}`,
              },
              {
                type: 'mrkdwn',
                text: `*Reporter:*\n${issue.fields.reporter.displayName}`,
              },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Zobacz w Jira',
                  emoji: true,
                },
                url: `${payload.issue.self.split('/rest/api')[0]}/browse/${issue.key}`,
                style: 'primary',
              },
            ],
          },
        ],
      };

      const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackMessage),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return NextResponse.json(
          {
            error: 'Failed to send to Slack',
            status: response.status,
            details: errorText,
          },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          message: 'Notification sent to Slack',
          issue: issue.key,
          transition: `${fromStatus} → ${toStatus}`,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        message: 'Status change not matching criteria',
        from: fromStatus,
        to: toStatus,
        expected: 'W TRAKCIE WERYFIKACJI → DO ZROBIENIA',
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
