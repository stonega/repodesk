# Isolated verification of the native host service. Production runs it on Linux.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY scripts/browser-host-smoke.ts scripts/browser-firewall-smoke.ts ./scripts/
COPY deploy/browser ./deploy/browser
RUN bun deploy/browser/package.ts /package
RUN bun build --target=node --packages=external scripts/browser-firewall-smoke.ts --outfile=/build/browser-firewall-smoke.js
RUN bun build --target=node --packages=external --outdir=dist --entry-naming='[name].js' \
    scripts/browser-host-smoke.ts
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node-runtime
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS nft-compatibility
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends nftables ca-certificates libatomic1 libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=build /package/ /opt/repodesk-browser/
COPY --from=build /build/browser-firewall-smoke.js /opt/repodesk-browser/
# Ubuntu 24.04 nft rejects Node socket stdin. Run the real production firewall.
CMD ["node", "/opt/repodesk-browser/browser-firewall-smoke.js"]
FROM node-runtime AS headed-smoke
# Bootstrap apt HTTPS from Node's bundled public roots; ca-certificates maintains
# the system trust store after installation.
RUN node -e "require('node:fs').mkdirSync('/etc/ssl/certs',{recursive:true});require('node:fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\n'))"
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=2 -o Acquire::https::Timeout=30 update && apt-get install -y --no-install-recommends \
    ca-certificates chromium chromium-sandbox xvfb xauth dbus-daemon dbus-x11 nftables passwd procps fonts-liberation x11-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/repodesk
COPY --from=build /package/ ./
COPY --from=build /build/dist/browser-host-smoke.js ./
COPY --from=build /build/deploy/browser/install-smoke.sh ./
ENV BROWSER_EXECUTABLE=/usr/bin/chromium BROWSER_HOST_ROOT=/var/lib/repodesk-browser
CMD ["node", "browser-host-smoke.js"]
