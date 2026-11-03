# Google Play

The Android app ships through Google Play. Every huubhuub release runs `.github/workflows/app-release.yml`:

- **Native code changed** (a fingerprint without a `play/<fingerprint>` tag): GitHub Actions builds an AAB,
  signs it with the upload key and uploads it to the **internal testing** track. Promote it to production in
  the Play Console by hand.
- **Only JavaScript changed**: an over-the-air update on the `production` channel (EAS Update). Play builds
  download it in the background.

The app's version is the bot's version (root `package.json`). Its versionCode is derived from it: 0.7.0
becomes 7000, 1.4.2 becomes 1004002. Google Play rejects a versionCode it already has. That only happens when
the same version is built twice, e.g. with the workflow's "build" checkbox; release first in that case.

## One-time setup

### 1. Upload key

Google Play signs the installed app with its own key (Play App Signing). The upload key only proves that an
upload comes from you. Make one and keep a copy somewhere safe, such as a password manager. If it's lost, Google
can reset it, but that takes a few days.

```sh
keytool -genkeypair -storetype PKCS12 -keystore huubhuub-upload.p12 -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=HuubHuub"
base64 -i huubhuub-upload.p12 | gh secret set ANDROID_UPLOAD_KEYSTORE
gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD   # the password you just picked
```

The alias has to be `upload`.

### 2. Firebase

Push notifications need Firebase's `google-services.json` in the build (Firebase console → project settings →
the Android app `dev.thijmen.apps.huubhuub`). Older setups registered `nl.thijmen.huubhuub`: add an Android app
with the new package name to the same Firebase project and download the file again, or the build fails with
"No matching client found for package name". The FCM key in EAS stays the same.

```sh
gh secret set GOOGLE_SERVICES_JSON < google-services.json
```

### 3. The app in the Play Console

1. Play Console → **Create app**: name HuubHuub, app, free.
2. Run **App release** by hand (Actions → App release → Run workflow, tick "build"). Without the Play service
   account it stops after building. Download the AAB from the run's artifacts.
3. **Testing → Internal testing → Create new release**, keep Play App Signing on (the default), upload the AAB
   and roll it out. The package name, `dev.thijmen.apps.huubhuub`, is fixed from then on. The API can only upload to
   an app that already has one build, so this first one is by hand.
4. Add testers (an email list) on the internal testing track and open the opt-in link on the phone.

New personal developer accounts can only publish to production after a **closed** test with at least 12 testers
for 14 days. Internal testing doesn't count towards that.

### 4. Service account for uploads

1. [Google Cloud console](https://console.cloud.google.com/): pick or create a project, and enable the
   **Google Play Android Developer API**.
2. **IAM → Service accounts → Create**. Give it no roles. Open it, **Keys → Add key → JSON**.
3. Play Console → **Users and permissions → Invite new users**: the service account's email. Under app
   permissions, add HuubHuub with "Release apps to testing tracks" (and "Release to production" if you want
   that later).
4. `gh secret set PLAY_SERVICE_ACCOUNT_JSON < key.json`, then delete `key.json`.

It can take a few hours before Google accepts a new service account.

### 5. Expo

Over-the-air updates and push still use the Expo project in `app/app.config.ts`. `EXPO_TOKEN` (an Expo
access token) has to be set as a repository secret. The FCM v1 key for push stays in EAS (`eas credentials`).

## Things to know

- Phones that still have the APK from the old `app-android` GitHub release can't upgrade in place: Play signs
  with another key. Uninstall it, install from Play, and sign in again. That release isn't updated anymore and
  can be deleted.
- The play/<fingerprint> tag is pushed only after a successful upload. Deleting one makes the next release
  build that native code again.
- Pull requests say whether they change the native code, and so whether the next release builds for Play.
