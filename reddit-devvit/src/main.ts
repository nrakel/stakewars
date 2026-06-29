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
    (await context.settings.get<string>("stakewars-origin")) || "https://stakewars.phisystems.ai"
  );
  const secret = await context.settings.get<string>("stakewars-shared-secret");
  if (!secret) {
    throw new Error("Missing StakeWars shared secret app setting");
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
  label: "Post next StakeWars draft",
  location: "subreddit",
  onPress: async (_event, context) => {
    const message = await processQueue(context as DevvitContext);
    context.ui.showToast(message);
  }
});

Devvit.addMenuItem({
  label: "Start StakeWars queue polling",
  location: "subreddit",
  onPress: async (_event, context) => {
    await (context as DevvitContext).scheduler.runJob({
      name: "pollStakeWarsQueue",
      cron: "*/5 * * * *"
    });
    context.ui.showToast("StakeWars queue polling scheduled.");
  }
});

export default Devvit;
