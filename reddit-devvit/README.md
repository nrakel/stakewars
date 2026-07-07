# StakeWars Reddit Devvit App

This companion app publishes admin-approved StakeWars posts from Reddit's server runtime.

StakeWars owns the preview, approval, and queue. Devvit owns the actual Reddit API call.

## Settings

Configure StakeWars from Reddit after installing the app:

1. Open the installed app menu in the subreddit.
2. Select `Configure StakeWars`.
3. Enter:
   - `StakeWars origin`: `https://reddit-api.stakewars.phisystems.ai`
   - `StakeWars shared secret`: the same value as `REDDIT_DEVVIT_SHARED_SECRET` in `/etc/stakewars/stakewars.env`

These values are stored in Devvit Redis for the app. The app also declares these
as app settings, but the Reddit Developer Portal may not expose the settings UI
for this app.

The fallback form does not mask the shared secret while typing because Devvit
only allows masked secret fields in app settings, not regular action forms.

Fallback app settings, if the portal exposes them later:

- `stakewars-origin`: `https://reddit-api.stakewars.phisystems.ai`
- `stakewars-shared-secret`: the same value as `REDDIT_DEVVIT_SHARED_SECRET` in `/etc/stakewars/stakewars.env`

The app has been uploaded to Reddit as `stakewars-picks`.

- App page: `https://developers.reddit.com/apps/stakewars-picks`
- Playtest subreddit: `https://www.reddit.com/r/stakewars_picks_dev`

The Devvit CLI currently uploads the app successfully, but `devvit settings set`
returns an unimplemented Reddit settings RPC error in this environment.

## Fetch Domains

This app requests the following Devvit HTTP fetch domain:

| Domain | Direction | Purpose |
| --- | --- | --- |
| `reddit-api.stakewars.phisystems.ai` | Devvit -> StakeWars | Claim one admin-approved Reddit post from the StakeWars queue and report whether Reddit publishing succeeded or failed. |

The app calls only these StakeWars endpoints:

- `POST https://reddit-api.stakewars.phisystems.ai/api/devvit/reddit/claim`
- `POST https://reddit-api.stakewars.phisystems.ai/api/devvit/reddit/result`

Reviewer-facing pages for the requested fetch domain:

- `https://reddit-api.stakewars.phisystems.ai/`
- `https://reddit-api.stakewars.phisystems.ai/terms`
- `https://reddit-api.stakewars.phisystems.ai/privacy`

Both requests use `Authorization: Bearer <stakewars-shared-secret>`. The shared
secret is configured by a moderator through the `Configure StakeWars` menu item
and stored in Devvit Redis for the installed app.

StakeWars owns this domain and operates the API. The API does not collect Reddit
user data. The only payload received by Devvit from StakeWars is an
admin-approved post draft containing subreddit, title, and body. The result call
sends back the queue id, post status, Reddit fullname, Reddit URL, or an error
message so StakeWars can close the queue item.

Useful CLI commands from this directory:

```bash
npx -p node@20 node node_modules/devvit/bin/devvit.js whoami
npx -p node@20 node node_modules/devvit/bin/devvit.js upload --copy-paste
npx -p node@20 node node_modules/devvit/bin/devvit.js view
```

## Flow

1. In StakeWars, generate a preview from Nate Rakel's account.
2. Edit the subreddit, title, or body if needed.
3. Click `Queue for Reddit`.
4. In Reddit, use the `Post next StakeWars draft` menu item for an ad hoc post, or use `Start StakeWars queue polling` to check every five minutes.

The Devvit app calls:

- `POST /api/devvit/reddit/claim`
- `POST /api/devvit/reddit/result`

Both calls require `Authorization: Bearer <stakewars-shared-secret>`.
