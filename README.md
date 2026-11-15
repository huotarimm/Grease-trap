# TrapLog: grease trap service proof & compliance

Working name. This is a two-sided web app:

1. **Service companies** (FCF and other pumpers). Techs open a site on their phone (or scan the QR sticker on the trap lid), take the required before/after photos, enter FOG and solids depths, and submit. It replaces the Whip Around "Grease Trap Pump out/Clean" form, but every report is tied to a real facility record instead of a free-text "saanich mc d's".
2. **The regulator** (CRD). Logs in and sees every restaurant in the region: who is compliant, due soon, overdue or never serviced, with photo proof for every service. They can filter by municipality or contractor and export CSV or print reports.

## What's in the MVP

| Area | Features |
|---|---|
| Tech (mobile) | Site list sorted by urgency; 7-step photo checklist (mirrors the current Whip Around form); required-photo enforcement; photos compressed on the phone and stamped with site, time and GPS; FOG/solids → % full with the 25% rule; condition + damage notes; disposal site + manifest #; upload progress and retry on bad signal |
| Proof / integrity | GPS captured and compared to the facility location (flagged if > 250 m away); SHA-256 fingerprint of every photo; records locked after submit; audit log; QR site stickers so jobs can't land on the wrong restaurant |
| Contractor office | Dashboard of their own sites (overdue = work to book), facility add/edit, service log + CSV, team / technician accounts |
| Regulator (CRD) | Regional dashboard + by-municipality compliance; facility database with status filters; full service report pages (printable / PDF); contractor scorecard (compliance %, avg % full, GPS flags); period report: not serviced, deficiencies, waste volume; CSV exports |
| Data separation | Contractors only see their own reports and photos; the regulator sees everything |

## Run it

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there's no database server to install).

```bash
npm install
npm start                    # http://localhost:3000, seeds demo data on first run
BASE=http://localhost:3000 npm run smoke   # end-to-end test
npm run seed                 # wipe and re-seed demo data
```

Demo logins (password `demo1234`): `crd@demo.test` (regulator), `admin@fcf.demo.test` (FCF office), `tech@fcf.demo.test` (FCF technician). All demo restaurants and other contractors are fictional.

Settings via env: `PORT`, `DATA_DIR` (DB + photos), `APP_NAME`, `PCT_FULL_THRESHOLD` (default 25), `GPS_FLAG_M` (default 250), `SEED_DEMO=0` for production.

## Before selling it to a government client

- **Hosting in Canada.** BC public bodies generally need personal information kept in Canada (FOIPPA). Host on a Canadian region with backups, and move photos to object storage.
- **Security.** Add password reset, invite emails, 2FA for regulator accounts, CSRF tokens, rate limiting and a privacy/security summary for procurement.
- **Offline capture.** Basements and kitchens often have no signal. Add a PWA offline queue so a report can be finished with no signal and synced later.
- **Bulk import.** The CRD's existing list of food service establishments should be importable from CSV so the database starts complete.
- **Notifications.** Overdue reminders to restaurants and contractors, plus a weekly summary email to the CRD rep.
- **Rules check.** Confirm the CRD's actual code of practice requirements (pump trigger, record retention, required fields) and set them in config.
- **Native wrapper (optional).** It's a mobile web app now. Wrap it with Capacitor if app-store presence or stronger camera control is needed.
