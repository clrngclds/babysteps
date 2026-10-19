# QA scripts (optional)

Headless-Chrome scripts used for Phase 1 QA. They are not part of the app and need
`puppeteer-core` plus a local Chrome, installed outside the project:

```sh
mkdir -p /tmp/qa && cp qa/*.mjs /tmp/qa/ && cd /tmp/qa
echo '{"type":"module"}' > package.json && npm i puppeteer-core
# with the static export served on :4321 (python3 -m http.server 4321 --directory out)
node shots.mjs http://localhost:4321 screenshots   # 390×844, 900×1100 and 1440×900 screenshots
node audit.mjs http://localhost:4321               # contrast, tap targets, offline, persistence, third-party requests
node swipe.mjs                                     # pointer swipe gestures (port 4321)
node icons.mjs <project>/public/icons/icon.svg <project>/public/icons   # re-render PNG icons
```

The scripts expect Chrome at `/usr/bin/google-chrome`; edit `executablePath` if yours differs.

`live.mjs` checks a deployed URL at 390×844: onboarding, Today, service worker registration and
control, cache contents, the visit ping (expects 204), CSP violations, third-party requests, and
Today / Milestones / activity detail with the network off. It writes screenshots to the given folder:
```sh
node live.mjs https://web-312918712586.asia-southeast1.run.app screenshots
```
