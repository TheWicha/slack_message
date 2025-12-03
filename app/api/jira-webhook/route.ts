import { NextRequest, NextResponse } from 'next/server';

// Clean the URL by removing any quotes, semicolons, or whitespace
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function POST(request: NextRequest) {
  try {
    console.log('=== Webhook received ===');
    console.log('Slack URL configured:', !!SLACK_WEBHOOK_URL);
    console.log('Slack URL length:', SLACK_WEBHOOK_URL?.length);

    const payload = await request.json();
    console.log('Webhook event:', payload.webhookEvent);

    const webhookEvent = payload.webhookEvent;
    const issue = payload.issue;

    if (webhookEvent !== 'jira:issue_updated') {
      console.log('Not an issue update, skipping');
      return NextResponse.json({ message: 'Not an issue update' }, { status: 200 });
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
    console.log(`Status change: ${fromStatus} → ${toStatus}`);

    if (fromStatus === 'To Do' && toStatus === 'Done') {
      console.log('Match! Sending to Slack...');

      if (!SLACK_WEBHOOK_URL) {
        console.error('SLACK_WEBHOOK_URL is not configured!');
        return NextResponse.json({ error: 'Slack webhook URL not configured' }, { status: 500 });
      }

      const slackMessage = {
        text: `✅ Zadanie ukończone: ${issue.key}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '✅ Zadanie Ukończone',
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

      console.log('Sending to Slack URL:', SLACK_WEBHOOK_URL.substring(0, 40) + '...');

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

    console.log('Status change does not match criteria');
    return NextResponse.json(
      {
        message: 'Status change not matching criteria',
        from: fromStatus,
        to: toStatus,
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
  const rawUrl = process.env.SLACK_WEBHOOK_URL;
  const cleanUrl = rawUrl?.trim().replace(/^['"]|['"];?$/g, '');

  return NextResponse.json({
    status: 'healthy',
    message: 'Jira webhook endpoint is running',
    slackConfigured: !!cleanUrl,
    debug: {
      rawUrlLength: rawUrl?.length || 0,
      cleanUrlLength: cleanUrl?.length || 0,
      hasQuotes: rawUrl?.includes("'") || rawUrl?.includes('"'),
      urlPreview: cleanUrl ? cleanUrl.substring(0, 40) + '...' : 'not set',
    },
  });
}
