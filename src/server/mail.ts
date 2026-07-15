import { createHash, createHmac } from "node:crypto";
import { config } from "./config.js";

type MailRecipient = {
  email: string;
  name?: string;
};

type SendMailInput = {
  to: MailRecipient[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: MailRecipient[];
};

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAtMs: number;
};

let cachedAwsCredentials: AwsCredentials | null = null;

const sesMailConfig = () => {
  const missing = [
    ["SES_REGION/AWS_REGION", config.sesRegion],
    ["SES_FROM_EMAIL", config.sesFromEmail]
  ].filter(([, value]) => !value).map(([name]) => name);

  const hasStaticAccessKey = Boolean(config.sesAccessKeyId || config.sesSecretAccessKey || config.sesSessionToken);
  if (hasStaticAccessKey && (!config.sesAccessKeyId || !config.sesSecretAccessKey)) {
    missing.push("SES_ACCESS_KEY_ID/AWS_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY/AWS_SECRET_ACCESS_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`Amazon SES mail is not configured. Missing: ${missing.join(", ")}`);
  }

  return {
    region: config.sesRegion!,
    accessKeyId: config.sesAccessKeyId,
    secretAccessKey: config.sesSecretAccessKey,
    sessionToken: config.sesSessionToken,
    fromEmail: config.sesFromEmail!,
    fromName: config.sesFromName
  };
};

export const isSesMailConfigured = () => {
  try {
    sesMailConfig();
    return true;
  } catch {
    return false;
  }
};

const formatAddress = (recipient: MailRecipient) => {
  if (!recipient.name) {
    return recipient.email;
  }
  const escapedName = recipient.name.replace(/(["\\])/g, "\\$1");
  return `"${escapedName}" <${recipient.email}>`;
};

const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value, "utf8").digest();

const awsLongDate = (date: Date) =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const awsShortDate = (date: Date) =>
  awsLongDate(date).slice(0, 8);

const awsSigningKey = (secretAccessKey: string, date: string, region: string, service: string) => {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
};

const imdsToken = async () => {
  const response = await fetch("http://169.254.169.254/latest/api/token", {
    method: "PUT",
    headers: {
      "x-aws-ec2-metadata-token-ttl-seconds": "21600"
    }
  });
  if (!response.ok) {
    throw new Error(`EC2 metadata token request failed: ${response.status}`);
  }
  return response.text();
};

const imdsFetch = async (path: string, token: string) => {
  const response = await fetch(`http://169.254.169.254/latest/meta-data/${path}`, {
    headers: {
      "x-aws-ec2-metadata-token": token
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`EC2 metadata request failed: ${path} ${response.status} ${body.slice(0, 200)}`);
  }
  return response.text();
};

const awsCredentials = async () => {
  if (config.sesAccessKeyId && config.sesSecretAccessKey) {
    return {
      accessKeyId: config.sesAccessKeyId,
      secretAccessKey: config.sesSecretAccessKey,
      sessionToken: config.sesSessionToken
    };
  }
  if (cachedAwsCredentials && cachedAwsCredentials.expiresAtMs > Date.now() + 5 * 60_000) {
    return cachedAwsCredentials;
  }

  const token = await imdsToken();
  const roleName = (await imdsFetch("iam/security-credentials/", token)).trim().split("\n")[0];
  if (!roleName) {
    throw new Error("No EC2 instance role is available for SES credentials.");
  }
  const body = JSON.parse(await imdsFetch(`iam/security-credentials/${encodeURIComponent(roleName)}`, token)) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
    Expiration?: string;
    Code?: string;
    Message?: string;
  };
  if (body.Code && body.Code !== "Success") {
    throw new Error(`EC2 role credential request failed: ${body.Code} ${body.Message ?? ""}`.trim());
  }
  if (!body.AccessKeyId || !body.SecretAccessKey || !body.Token || !body.Expiration) {
    throw new Error("EC2 role credentials response was incomplete.");
  }

  cachedAwsCredentials = {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
    expiresAtMs: new Date(body.Expiration).getTime()
  };
  return cachedAwsCredentials;
};

export const sendMail = async ({ to, subject, text, html, replyTo }: SendMailInput) => {
  if (to.length === 0) {
    throw new Error("At least one email recipient is required.");
  }
  if (!text && !html) {
    throw new Error("Email text or html body is required.");
  }

  const mailConfig = sesMailConfig();
  const credentials = await awsCredentials();
  const host = `email.${mailConfig.region}.amazonaws.com`;
  const endpoint = `https://${host}/v2/email/outbound-emails`;
  const now = new Date();
  const amzDate = awsLongDate(now);
  const dateStamp = awsShortDate(now);
  const body = JSON.stringify({
    FromEmailAddress: formatAddress({ email: mailConfig.fromEmail, name: mailConfig.fromName }),
    Destination: {
      ToAddresses: to.map(formatAddress)
    },
    ...(replyTo?.length ? { ReplyToAddresses: replyTo.map(formatAddress) } : {}),
    Content: {
      Simple: {
        Subject: {
          Data: subject,
          Charset: "UTF-8"
        },
        Body: {
          ...(text ? {
            Text: {
              Data: text,
              Charset: "UTF-8"
            }
          } : {}),
          ...(html ? {
            Html: {
              Data: html,
              Charset: "UTF-8"
            }
          } : {})
        }
      }
    }
  });
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    "/v2/email/outbound-emails",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${mailConfig.region}/ses/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = createHmac("sha256", awsSigningKey(credentials.secretAccessKey, dateStamp, mailConfig.region, "ses"))
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(", ");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      authorization
    },
    body
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Amazon SES SendEmail failed: ${response.status} ${responseBody.slice(0, 500)}`);
  }

  const responseBody = await response.json().catch(() => ({})) as { MessageId?: string };
  return { accepted: to.length, messageId: responseBody.MessageId ?? null };
};
