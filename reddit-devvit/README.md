# StakeWars Reddit Devvit App

This companion app publishes admin-approved StakeWars posts from Reddit's server runtime.

StakeWars owns the preview, approval, and queue. Devvit owns the actual Reddit API call.

## Settings

Configure these app settings after installing the app:

- `stakewars-origin`: `https://stakewars.phisystems.ai`
- `stakewars-shared-secret`: the same value as `REDDIT_DEVVIT_SHARED_SECRET` in `/etc/stakewars/stakewars.env`

## Flow

1. In StakeWars, generate a preview from Nate Rakel's account.
2. Edit the subreddit, title, or body if needed.
3. Click `Queue for Reddit`.
4. In Reddit, use the `Post next StakeWars draft` menu item for an ad hoc post, or use `Start StakeWars queue polling` to check every five minutes.

The Devvit app calls:

- `POST /api/devvit/reddit/claim`
- `POST /api/devvit/reddit/result`

Both calls require `Authorization: Bearer <stakewars-shared-secret>`.
