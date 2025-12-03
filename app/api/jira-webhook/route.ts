import { NextRequest, NextResponse } from 'next/server';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

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

export async function POST(request: NextRequest) {
  try {
    console.log('=== Webhook received ===');

    const payload = await request.json();

    const webhookId = `${payload.issue?.key}_${payload.changelog?.id}_${payload.timestamp}`;

    if (processedWebhooks.has(webhookId)) {
      console.log('⚠️ Duplicate webhook detected, skipping:', webhookId);
      return NextResponse.json({ message: 'Duplicate webhook' }, { status: 200 });
    }

    console.log('Webhook event:', payload.webhookEvent);

    const webhookEvent = payload.webhookEvent;
    const issue = payload.issue;

    if (webhookEvent !== 'jira:issue_updated') {
      console.log('Not an issue update, skipping');
      return NextResponse.json({ message: 'Not an issue update' }, { status: 200 });
    }

    const projectKey = issue?.fields?.project?.key;
    if (projectKey !== 'MES') {
      console.log(`Not MES project (got ${projectKey}), skipping`);
      return NextResponse.json({ message: 'Not MES project' }, { status: 200 });
    }

    const changelog = payload.changelog;
    const statusChange = changelog?.items?.find(
      (item: { field: string }) => item.field === 'status'
    );

    if (!statusChange) {
      console.log('No status change detected');
      return NextResponse.json({ message: 'No status change' }, { status: 200 });
    }

    const fromStatus = statusChange.fromString;
    const toStatus = statusChange.toString;

    console.log('=== STATUS CHANGE ===');
    console.log('From:', fromStatus);
    console.log('To:', toStatus);
    console.log('Project:', projectKey);

    if (fromStatus === 'W trakcie weryfikacji' && toStatus === 'do zrobienia') {
      console.log('✅ Match! Sending to Slack...');

      processedWebhooks.set(webhookId, Date.now());

      if (!SLACK_WEBHOOK_URL) {
        console.error('SLACK_WEBHOOK_URL is not configured!');
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
                text: `*Status:*\n${fromStatus} → ${toStatus}`,
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

      console.log('Sending to Slack...');

      const response = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackMessage),
      });

      console.log('Slack response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Slack API error:', response.status, errorText);
        return NextResponse.json(
          {
            error: 'Failed to send to Slack',
            status: response.status,
            details: errorText,
          },
          { status: 500 }
        );
      }

      console.log('✅ Message sent to Slack successfully!');
      return NextResponse.json(
        {
          message: 'Notification sent to Slack',
          issue: issue.key,
          transition: `${fromStatus} → ${toStatus}`,
        },
        { status: 200 }
      );
    }

    console.log('❌ Status change does not match criteria');
    console.log('Expected: W TRAKCIE WERYFIKACJI → DO ZROBIENIA');
    console.log(`Got: ${fromStatus} → ${toStatus}`);

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
    console.error('Error processing webhook:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    message: 'Jira webhook endpoint is running',
    slackConfigured: !!SLACK_WEBHOOK_URL,
    config: {
      project: 'MES',
      transition: 'W TRAKCIE WERYFIKACJI → DO ZROBIENIA',
      messageTitle: 'Zadanie Gotowe do Realizacji',
      cachedWebhooks: processedWebhooks.size,
    },
  });
}
