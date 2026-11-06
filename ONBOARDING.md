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
npx wrangler secret put CLOUDFLARE_AI_API_TOKEN            # for api_token providers; a token that can use your AI Gateway
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

### Required: block cross-site writes at the WAF

The Worker doesn't check where a write came from. **Before your first deploy,** add a custom WAF rule on your hostname (Security > WAF > Custom rules), action Block:

```
(starts_with(http.request.uri.path, "/__af/") and not http.request.method in {"GET" "HEAD"} and any(http.request.headers["sec-fetch-site"][*] in {"cross-site" "same-site"}))
```

### From a machine behind TLS inspection

`wrangler deploy` can't pass a build secret, and an image must never inherit a proxy's CA. Build by hand, and deploy the pushed image:

```bash
TAG=agent-flare:$(git rev-parse --short HEAD)
AF_NO_CACHE=1 AF_BUILD_CA=/path/to/ca-bundle.crt AF_FORBIDDEN_CA=/path/to/proxy-ca.crt scripts/build-image.sh "$TAG"   # stops if the guard fails
npx wrangler containers push "$TAG"                                                                                    # prints the registry image
AF_IMAGE=<that registry image> AF_WRANGLER_OUT=wrangler.prod.jsonc node scripts/render-wrangler.mjs
node scripts/check-deploy.mjs wrangler.prod.jsonc
npx wrangler deploy --config wrangler.prod.jsonc
```

The `Dockerfile` pins its base by digest, so a local image with the same tag can't become the base without an explicit `AF_BASE_IMAGE`. `scripts/check-image.sh` refuses an image with the CA or its settings in its env, history or files.

## 5. Add a provider template

Without one, users open Hermes with no inference provider.

```bash
cp -r templates/example templates/mine        # replace each YOUR_ value; templates/* is gitignored
node scripts/templates.mjs check templates/mine   # lists the Worker secrets it needs
node scripts/templates.mjs push templates/mine
cp templates/assignments.example.json assignments.json   # edit it
node scripts/templates.mjs assign assignments.json
```

To fill in the example you need your account ID, gateway ID, and the model IDs your gateway serves. Delete the `own-key` provider if you don't want a per-user option. See [Providers](README.md#providers).

## 6. Open it

Go to `https://agents.example.com`. Log in through Access, watch the starting page, and you're in Hermes with the template's model selected. Send a message.

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
| Hermes asks to connect a provider | No provider has a credential. `/__af/admin/users` shows `config.inference.missing` and `config.warnings`. Set the secret and the user's next boot selects it |
| Messages fail with 401 or 403 | The credential was refused: check the Worker secret can use that gateway |

For a debug shell, set `containers[0].ssh.enabled` to true, add your `ssh-ed25519` key under `authorized_keys`, redeploy and use `wrangler containers ssh`.
