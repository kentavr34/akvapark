#!/usr/bin/env bash
# ==========================================================================
#  Сборка Android-версии игры прямо на сервере.
#  Первый запуск сам ставит JDK, Android SDK и Gradle (минут 10-15),
#  дальше собирает за минуту. Результат кладётся в /opt/akvapark/dist,
#  откуда его отдаёт nginx как /akvapark.apk
#
#  bash /opt/akvapark/repo/server/build-apk.sh
# ==========================================================================
set -euo pipefail

BASE=/opt/akvapark
REPO=$BASE/repo
TOOLS=$BASE/toolchain
DIST=$BASE/dist
SDK=$TOOLS/android-sdk
GRADLE_VER=8.9
CMDLINE_VER=11076708           # cmdline-tools 12.0
BUILD_TOOLS=34.0.0
PLATFORM=android-34

mkdir -p "$TOOLS" "$DIST"
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
export ANDROID_HOME=$SDK
export ANDROID_SDK_ROOT=$SDK

say(){ echo "==> $*"; }

# ---------- 1. JDK ----------
if [ ! -x "$JAVA_HOME/bin/javac" ]; then
  say "ставлю JDK 17"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openjdk-17-jdk-headless unzip curl >/dev/null
fi
"$JAVA_HOME/bin/java" -version 2>&1 | head -1

# ---------- 2. Android SDK ----------
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  say "ставлю Android SDK"
  mkdir -p "$SDK/cmdline-tools"
  curl -fsSL -o /tmp/cmdline.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip"
  rm -rf "$SDK/cmdline-tools/latest" /tmp/cmdline-tools
  unzip -q /tmp/cmdline.zip -d /tmp
  mv /tmp/cmdline-tools "$SDK/cmdline-tools/latest"
  rm -f /tmp/cmdline.zip
fi
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"

if [ ! -d "$SDK/platforms/$PLATFORM" ]; then
  say "принимаю лицензии и качаю платформу"
  yes | sdkmanager --licenses >/dev/null 2>&1 || true
  sdkmanager --install "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" "platform-tools" >/dev/null
fi

# ---------- 3. Gradle ----------
GRADLE="$TOOLS/gradle-$GRADLE_VER/bin/gradle"
if [ ! -x "$GRADLE" ]; then
  say "ставлю Gradle $GRADLE_VER"
  curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-$GRADLE_VER-bin.zip"
  unzip -q /tmp/gradle.zip -d "$TOOLS"
  rm -f /tmp/gradle.zip
fi

# ---------- 4. ключ подписи ----------
# Один и тот же ключ на всю жизнь игры: сменишь — обновление поверх
# установленной игры откажется ставиться.
KEYSTORE=$TOOLS/akvapark-release.jks
KEYPROPS=$REPO/android/keystore.properties
if [ ! -f "$KEYSTORE" ]; then
  say "создаю ключ подписи (один раз, храню в $KEYSTORE)"
  PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" -storepass "$PASS" -keypass "$PASS" \
    -alias akvapark -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Akvapark, OU=Game, O=Akvapark, L=Baku, C=AZ" >/dev/null 2>&1
  printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=akvapark\nkeyPassword=%s\n' \
    "$KEYSTORE" "$PASS" "$PASS" > "$TOOLS/keystore.properties"
  chmod 600 "$KEYSTORE" "$TOOLS/keystore.properties"
fi
cp -f "$TOOLS/keystore.properties" "$KEYPROPS"

# ---------- 5. сборка ----------
say "собираю apk"
cd "$REPO/android"
"$GRADLE" --no-daemon -q clean assembleRelease

APK=$(find "$REPO/android/app/build/outputs/apk/release" -name "*.apk" | head -1)
if [ -z "$APK" ]; then echo "СБОРКА НЕ ДАЛА APK"; exit 1; fi

VER=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$REPO/version.json" | sed 's/.*"\([^"]*\)"$/\1/')
BUILD=$(grep -o '"build"[[:space:]]*:[[:space:]]*[0-9]\+' "$REPO/version.json" | grep -o '[0-9]\+$')

cp -f "$APK" "$DIST/akvapark.apk.new"
mv -f "$DIST/akvapark.apk.new" "$DIST/akvapark.apk"
SIZE=$(stat -c%s "$DIST/akvapark.apk")
SHA=$(sha256sum "$DIST/akvapark.apk" | cut -d' ' -f1)

cat > "$DIST/apk.json" <<EOF
{
  "version": "$VER",
  "build": $BUILD,
  "size": $SIZE,
  "sha256": "$SHA",
  "url": "https://akvapark.45.67.216.36.sslip.io/akvapark.apk",
  "date": "$(date -u +%FT%TZ)"
}
EOF

rm -f "$KEYPROPS"
chown -R www-data:www-data "$DIST" 2>/dev/null || true

echo
echo "APK готов: $DIST/akvapark.apk  ($((SIZE/1024/1024)) МБ, версия $VER, сборка $BUILD)"
echo "Ссылка:    https://akvapark.45.67.216.36.sslip.io/akvapark.apk"
