import { NextRequest, NextResponse } from 'next/server';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();

    // Extract basic info
    const webhookEvent = payload.webhookEvent;
    const issue = payload.issue;

    // Check if it's an issue update
    if (webhookEvent !== 'jira:issue_updated') {
      return NextResponse.json({ message: 'Not an issue update' }, { status: 200 });
    }

    // Check for status change in changelog
    const changelog = payload.changelog;
    const statusChange = changelog?.items?.find(
      (item: { field: string }) => item.field === 'status'
    );

    if (!statusChange) {
      return NextResponse.json({ message: 'No status change' }, { status: 200 });
    }

    // Check if transition is from "To Do" to "Done"
    const fromStatus = statusChange.fromString;
    const toStatus = statusChange.toString;

    if (fromStatus === 'To Do' && toStatus === 'Done') {
      // Send to Slack
      const slackMessage = {
        text: `✅ Issue completed!`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Issue Completed* ✅\n*${issue.key}*: ${issue.fields.summary}\n*Status:* ${fromStatus} → ${toStatus}\n*Reporter:* ${issue.fields.reporter.displayName}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'View Issue',
                },
                url: `${payload.issue.self.split('/rest/api')[0]}/browse/${issue.key}`,
              },
            ],
          },
        ],
      };
      if (SLACK_WEBHOOK_URL)
        await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackMessage),
        });

      return NextResponse.json({ message: 'Notification sent to Slack' }, { status: 200 });
    }

    return NextResponse.json({ message: 'Status change not matching criteria' }, { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
