type RewardConfirmationEmailInput = {
  displayName: string;
  weekStart: string;
  rewardCents: number;
  rank: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  topWagerDescription: string | null;
  topWagerProfitCents: number | null;
  accountUrl: string;
  logoUrl: string;
};

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const weekLabel = (weekStart: string) => {
  const [year, month, day] = weekStart.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
};

export const rewardConfirmationSubject = "You've earned a StakeWars Reward!";

export const buildRewardConfirmationEmail = (input: RewardConfirmationEmailInput) => {
  const record = `${input.wins}-${input.losses}${input.pushes ? `-${input.pushes}` : ""}`;
  const topWagerText = input.topWagerDescription && input.topWagerProfitCents !== null
    ? `${input.topWagerDescription} for ${dollars(input.topWagerProfitCents)} profit`
    : "Your strongest winning wager helped carry the week.";
  const safeDisplayName = escapeHtml(input.displayName);
  const safeTopWagerText = escapeHtml(topWagerText);
  const safeAccountUrl = escapeHtml(input.accountUrl);
  const safeLogoUrl = escapeHtml(input.logoUrl);
  const safeWeekLabel = escapeHtml(weekLabel(input.weekStart));
  const reward = dollars(input.rewardCents);

  const text = [
    `Congratulations, ${input.displayName}!`,
    "",
    "You earned a StakeWars reward after a hard fought week.",
    "",
    `Week of: ${weekLabel(input.weekStart)}`,
    `Leaderboard finish: #${input.rank}`,
    `Reward earned: ${reward}`,
    `Weekly record: ${record} W/L${input.pushes ? "/P" : ""}${input.voids ? `, ${input.voids} void` : ""}`,
    `Best winning wager: ${topWagerText}`,
    "",
    "Check your Account page to review your reward balance and payout details:",
    input.accountUrl,
    "",
    "Thanks for playing StakeWars."
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0b0b0f;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;">
      Congratulations. Your StakeWars reward is available on your Account page.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#15151b;border:1px solid #2a2a34;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;text-align:center;background:#050507;">
                <img src="${safeLogoUrl}" width="72" height="72" alt="StakeWars" style="display:block;margin:0 auto 14px;border:0;">
                <div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#f97316;font-weight:700;">StakeWars Reward</div>
                <h1 style="margin:10px 0 0;font-size:28px;line-height:1.15;color:#ffffff;">You've earned a reward.</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 16px;font-size:17px;line-height:1.55;color:#f8fafc;">Congratulations, <strong>${safeDisplayName}</strong>.</p>
                <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#d4d4dc;">That was a hard fought week, and you finished in reward position. Your reward balance has been updated in StakeWars.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 24px;">
                  <tr>
                    <td style="padding:12px;border:1px solid #30303a;color:#a8a8b3;">Week</td>
                    <td style="padding:12px;border:1px solid #30303a;color:#ffffff;font-weight:700;">${safeWeekLabel}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px;border:1px solid #30303a;color:#a8a8b3;">Finish</td>
                    <td style="padding:12px;border:1px solid #30303a;color:#ffffff;font-weight:700;">#${input.rank}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px;border:1px solid #30303a;color:#a8a8b3;">Reward</td>
                    <td style="padding:12px;border:1px solid #30303a;color:#ffffff;font-weight:700;">${reward}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px;border:1px solid #30303a;color:#a8a8b3;">Weekly record</td>
                    <td style="padding:12px;border:1px solid #30303a;color:#ffffff;font-weight:700;">${record}</td>
                  </tr>
                </table>
                <div style="padding:16px 18px;background:#202028;border-left:4px solid #f97316;border-radius:8px;margin:0 0 24px;">
                  <div style="font-size:13px;color:#a8a8b3;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px;">Biggest winning wager</div>
                  <div style="font-size:16px;line-height:1.45;color:#ffffff;">${safeTopWagerText}</div>
                </div>
                <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#d4d4dc;">Check your Account page to review your reward balance and payout details.</p>
                <p style="margin:0;text-align:center;">
                  <a href="${safeAccountUrl}" style="display:inline-block;background:#f97316;color:#050507;text-decoration:none;font-weight:800;border-radius:8px;padding:13px 20px;">Open Account Page</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#101015;color:#8c8c98;font-size:12px;line-height:1.45;text-align:center;">
                You are receiving this because your StakeWars account earned a weekly reward.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: rewardConfirmationSubject, text, html };
};

