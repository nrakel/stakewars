import { sendMail } from "../src/server/mail.js";

const to = process.env.TEST_EMAIL_TO;

if (!to) {
  throw new Error("Set TEST_EMAIL_TO to the recipient email address.");
}

const result = await sendMail({
  to: [{ email: to }],
  subject: "StakeWars email test",
  text: [
    "This is a test email from StakeWars through Amazon SES.",
    "",
    `Sent at: ${new Date().toISOString()}`
  ].join("\n")
});

console.log(JSON.stringify(result, null, 2));
