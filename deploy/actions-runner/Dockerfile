FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ARG RUNNER_VERSION=2.337.0
ARG RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ENV DEBIAN_FRONTEND=noninteractive

# Install Docker inside the CI container; never mount the production Docker socket.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git sudo unzip procps libstdc++6 \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && printf '%s\n' 'Types: deb' 'URIs: https://download.docker.com/linux/ubuntu' 'Suites: noble' 'Components: stable' 'Architectures: amd64' 'Signed-By: /etc/apt/keyrings/docker.asc' > /etc/apt/sources.list.d/docker.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && usermod --append --groups docker runner \
    && printf '%s\n' 'runner ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/actions-runner \
    && chmod 0440 /etc/sudoers.d/actions-runner

COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/actions-runner
RUN curl --fail --silent --show-error --location \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o /tmp/runner.tar.gz \
    && printf '%s  %s\n' "$RUNNER_SHA256" /tmp/runner.tar.gz | sha256sum --check \
    && tar --extract --gzip --file /tmp/runner.tar.gz \
    && ./bin/installdependencies.sh \
    && chown --recursive runner:runner /opt/actions-runner \
    && chmod 0700 /opt/actions-runner \
    && rm /tmp/runner.tar.gz \
    && apt-get clean

COPY --chmod=0755 entrypoint.sh /usr/local/bin/actions-runner-entrypoint
ENTRYPOINT ["/usr/local/bin/actions-runner-entrypoint"]
