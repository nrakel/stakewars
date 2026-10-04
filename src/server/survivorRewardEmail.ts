type SurvivorRewardEmailInput = {
  displayName: string;
  season: number;
  wins: number;
  rewardCents: number;
  accountUrl: string;
};

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const buildSurvivorChampionEmail = (input: SurvivorRewardEmailInput) => {
  const reward = dollars(input.rewardCents);
  const record = `${input.wins}-0`;
  const duration = input.wins === 1 ? "one week" : `${input.wins} weeks`;
  const safeName = escapeHtml(input.displayName);
  const safeAccountUrl = escapeHtml(input.accountUrl);
  const subject = "Congratulations, StakeWars Survivor Champion!";
  const text = [
    `Congratulations, ${input.displayName}!`,
    "",
    `You are the ${input.season} StakeWars NFL Survivor Champion!`,
    `It may have only taken ${duration}, but you survived every challenge and finished ${record}.`,
    "",
    `Champion reward: ${reward}`,
    "Your StakeWars reward balance has been updated.",
    "",
    "Review your reward on the Account page:",
    input.accountUrl,
    "",
    "Congratulations on being the last player standing!",
    "The StakeWars Team"
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0b0b0f;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;">You are the StakeWars NFL Survivor Champion.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:28px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#15151b;border:1px solid #34343e;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:30px;text-align:center;background:#050507;">
            <div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#f97316;font-weight:700;">StakeWars NFL Survivor</div>
            <h1 style="margin:10px 0 0;font-size:30px;line-height:1.15;color:#ffffff;">Last player standing.</h1>
          </td></tr>
          <tr><td style="padding:30px;">
            <p style="margin:0 0 16px;font-size:18px;line-height:1.55;color:#ffffff;">Congratulations, <strong>${safeName}</strong>!</p>
            <p style="margin:0 0 22px;font-size:16px;line-height:1.6;color:#d4d4dc;">You are the <strong>${input.season} StakeWars NFL Survivor Champion</strong>. It may have only taken ${duration}, but you survived every challenge and earned the title.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 24px;">
              <tr><td style="padding:13px;border:1px solid #34343e;color:#a8a8b3;">Final record</td><td style="padding:13px;border:1px solid #34343e;color:#ffffff;font-weight:800;">${record}</td></tr>
              <tr><td style="padding:13px;border:1px solid #34343e;color:#a8a8b3;">Champion reward</td><td style="padding:13px;border:1px solid #34343e;color:#ffffff;font-weight:800;">${reward}</td></tr>
            </table>
            <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#d4d4dc;">Your reward balance has been updated. Visit your Account page to review it.</p>
            <p style="margin:0;text-align:center;"><a href="${safeAccountUrl}" style="display:inline-block;background:#f97316;color:#050507;text-decoration:none;font-weight:800;border-radius:8px;padding:13px 20px;">Open Account Page</a></p>
          </td></tr>
          <tr><td style="padding:18px 28px;background:#101015;color:#8c8c98;font-size:12px;line-height:1.45;text-align:center;">Congratulations on being the last player standing.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
};
