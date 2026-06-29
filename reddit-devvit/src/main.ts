import { Devvit, SettingScope } from "@devvit/public-api";

type StakeWarsQueuedPost = {
  id: string;
  subreddit: string;
  title: string;
  body: string;
  createdAt: string;
};

type ClaimResponse = {
  post: StakeWarsQueuedPost | null;
};

type DevvitContext = {
  settings: {
    get<T>(name: string): Promise<T | undefined>;
  };
  redis: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<unknown>;
  };
  reddit: {
    submitPost(input: {
      subredditName: string;
      title: string;
      text: string;
      sendreplies?: boolean;
    }): Promise<{
      id: string;
      permalink?: string;
      url?: string;
    }>;
  };
  scheduler: {
    runJob(input: { name: string; cron: string }): Promise<unknown>;
  };
};

const stakeWarsOriginKey = "stakewars:origin";
const stakeWarsSharedSecretKey = "stakewars:shared-secret";

Devvit.configure({
  http: {
    domains: ["stakewars.phisystems.ai"]
  },
  redditAPI: true
});

Devvit.addSettings([
  {
    type: "string",
    name: "stakewars-origin",
    label: "StakeWars origin",
    scope: SettingScope.App,
    defaultValue: "https://stakewars.phisystems.ai"
  },
  {
    type: "string",
    name: "stakewars-shared-secret",
    label: "StakeWars shared secret",
    scope: SettingScope.App,
    isSecret: true
  }
]);

const configureStakeWarsForm = Devvit.createForm({
  title: "Configure StakeWars",
  description: "Stores the StakeWars API origin and shared secret for this Devvit app.",
  acceptLabel: "Save",
  fields: [
    {
      type: "string",
      name: "origin",
      label: "StakeWars origin",
      required: true,
      defaultValue: "https://stakewars.phisystems.ai"
    },
    {
      type: "string",
      name: "sharedSecret",
      label: "StakeWars shared secret",
      helpText: "Use REDDIT_DEVVIT_SHARED_SECRET from /etc/stakewars/stakewars.env.",
      required: true,
      isSecret: true
    }
  ]
}, async (event, context) => {
  const origin = String(event.values.origin || "").trim().replace(/\/+$/, "");
  const sharedSecret = String(event.values.sharedSecret || "").trim();
  if (!origin || !sharedSecret) {
    context.ui.showToast("StakeWars origin and shared secret are required.");
    return;
  }

  await context.redis.set(stakeWarsOriginKey, origin);
  await context.redis.set(stakeWarsSharedSecretKey, sharedSecret);
  context.ui.showToast("StakeWars Reddit settings saved.");
});

const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, "");

const normalizeRedditUrl = (url?: string) => {
  if (!url) {
    return "https://www.reddit.com/";
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `https://www.reddit.com${url.startsWith("/") ? "" : "/"}${url}`;
};

const stakeWarsFetch = async <T>(context: DevvitContext, path: string, body?: unknown): Promise<T> => {
  const origin = normalizeOrigin(
    (await context.redis.get(stakeWarsOriginKey))
    || (await context.settings.get<string>("stakewars-origin"))
    || "https://stakewars.phisystems.ai"
  );
  const secret = (await context.redis.get(stakeWarsSharedSecretKey))
    || (await context.settings.get<string>("stakewars-shared-secret"));
  if (!secret) {
    throw new Error("Missing StakeWars shared secret. Use the Configure StakeWars menu item first.");
  }

  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`StakeWars ${path} failed with ${response.status}: ${details}`);
  }

  return response.json() as Promise<T>;
};

const reportPosted = async (context: DevvitContext, post: StakeWarsQueuedPost, redditPost: Awaited<ReturnType<DevvitContext["reddit"]["submitPost"]>>) => {
  await stakeWarsFetch(context, "/api/devvit/reddit/result", {
    id: post.id,
    status: "posted",
    redditFullname: redditPost.id.startsWith("t3_") ? redditPost.id : `t3_${redditPost.id}`,
    redditUrl: normalizeRedditUrl(redditPost.permalink || redditPost.url)
  });
};

const reportFailed = async (context: DevvitContext, post: StakeWarsQueuedPost, error: unknown) => {
  await stakeWarsFetch(context, "/api/devvit/reddit/result", {
    id: post.id,
    status: "failed",
    errorMessage: error instanceof Error ? error.message : String(error)
  });
};

const processQueue = async (context: DevvitContext) => {
  const claim = await stakeWarsFetch<ClaimResponse>(context, "/api/devvit/reddit/claim");
  if (!claim.post) {
    return "No queued StakeWars Reddit posts.";
  }

  try {
    const redditPost = await context.reddit.submitPost({
      subredditName: claim.post.subreddit,
      title: claim.post.title,
      text: claim.post.body,
      sendreplies: false
    });
    await reportPosted(context, claim.post, redditPost);
    return `Posted StakeWars update to r/${claim.post.subreddit}.`;
  } catch (error) {
    await reportFailed(context, claim.post, error);
    throw error;
  }
};

Devvit.addSchedulerJob({
  name: "pollStakeWarsQueue",
  onRun: async (_event, context) => {
    await processQueue(context as DevvitContext);
  }
});

Devvit.addMenuItem({
  label: "Configure StakeWars",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    context.ui.showForm(configureStakeWarsForm);
  }
});

Devvit.addMenuItem({
  label: "Post next StakeWars draft",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    const message = await processQueue(context as DevvitContext);
    context.ui.showToast(message);
  }
});

Devvit.addMenuItem({
  label: "Start StakeWars queue polling",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    await (context as DevvitContext).scheduler.runJob({
      name: "pollStakeWarsQueue",
      cron: "*/5 * * * *"
    });
    context.ui.showToast("StakeWars queue polling scheduled.");
  }
});

export default Devvit;
