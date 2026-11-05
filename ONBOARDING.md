# Deploying Agent Flare

You need a Cloudflare account on the Workers paid plan (Containers require it), a domain on Cloudflare, and Cloudflare Access (Zero Trust).

## 1. Create the Access application

Zero Trust → Access → Applications → Add an application → Self-hosted.

- **Domain:** the hostname you'll use, such as `agents.example.com`.
- **Policy:** who may use it, such as Allow, emails ending in your domain.
- Copy the **Application Audience (AUD) tag**.
- Note your **team domain**, `<team>.cloudflareaccess.com`.

Don't create the DNS record. The Worker's custom domain does that.

## 2. Create storage

```bash
npm ci
npx wrangler r2 bucket create agent-flare-state
npx wrangler kv namespace create agent-flare-credentials   # note the id
```

## 3. Set secrets

```bash
openssl rand -base64 48 | npx wrangler secret put MASTER_KEY
npx wrangler secret put CLOUDFLARE_AI_API_TOKEN            # optional: for api_token providers
```

Store `MASTER_KEY` somewhere safe too. Without it, everything encrypted in KV is lost.

`wrangler secret put` needs the Worker's name, so run it after the first deploy if it complains, or pass `--name agent-flare`.

## 4. Deploy

### From GitHub (Workers Builds)

Fork this repo, then in the dashboard: Workers & Pages → Create → Import a repository.

- **Build command:** `node scripts/render-wrangler.mjs`
- **Deploy command:** `npx wrangler deploy`
- **Build variables:** the ones below

| Variable | Example | Required |
|---|---|---|
| `AF_HOSTNAME` | `agents.example.com` | Yes |
| `ACCESS_TEAM_DOMAIN` | `myteam.cloudflareaccess.com` | Yes |
| `ACCESS_AUD_TAG` | from step 1 | Yes |
| `AF_KV_ID` | from step 2 | Yes |
| `AF_ADMIN_EMAILS` | `you@example.com` | No |
| `AF_R2_BUCKET` | default `agent-flare-state` | No |
| `AF_MAX_INSTANCES` | default `10`: at most this many users awake at once | No |
| `AF_WORKER_NAME` | default `agent-flare` | No |

Every push to your production branch redeploys.

### From your machine

Needs Docker running.

```bash
export AF_HOSTNAME=agents.example.com ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com \
       ACCESS_AUD_TAG=... AF_KV_ID=... AF_ADMIN_EMAILS=you@example.com
node scripts/render-wrangler.mjs
npx wrangler deploy
```

## 5. Add a template (optional)

```bash
cp -r templates/example templates/mine        # edit it; templates/* is gitignored
node scripts/templates.mjs push templates/mine
cp templates/assignments.example.json assignments.json   # edit it
node scripts/templates.mjs assign assignments.json
```

## 6. Open it

Go to `https://agents.example.com`. Log in through Access, watch the starting page, and you're in Hermes.

## Check it worked

```bash
# Should be refused without Access:
curl -s -o /dev/null -w '%{http_code}\n' https://agents.example.com/     # 302 to Access

# In the webapp: change something, then in the browser console:
#   fetch('/__af/stop', {method:'POST'})
# Reload. The starting page shows, and your change is still there.
```

Check `/__af/admin/users` for backup counts, and `npx wrangler tail` for logs.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Invalid Access token` | `ACCESS_AUD_TAG` or `ACCESS_TEAM_DOMAIN` doesn't match the Access application |
| "Your agent couldn't start" with "none could be restored" | Backups exist and all failed verification. They're untouched; check `wrangler tail`. To start the user fresh, delete `users/<sub>/backups-index.json` from R2 |
| "MASTER_KEY must be set" | Set the Worker secret (step 3) |
| Starting page never finishes | `wrangler tail`; also check `max_instances`. A user past the limit can't get a container |
| Sent to `/login` instead of straight in | The webapp credential changed. Click Sign in with Cloudflare Access once |
| User's settings reverted | The key is in the template's `config_managed` or `env`, which reapply on every boot |

For a debug shell, set `containers[0].ssh.enabled` to true, add your `ssh-ed25519` key under `authorized_keys`, redeploy and use `wrangler containers ssh`.
