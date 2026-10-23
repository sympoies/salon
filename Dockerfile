# syntax=docker/dockerfile:1
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# The released GNU agent-session binary requires trixie's newer glibc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep tmux zsh \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu; digest=118c37aae503f0b83c4a79cd586e6a63a12fd9376aa0d1ed873afb148df7c7db ;; \
      arm64) target=aarch64-unknown-linux-gnu; digest=d0b6d5dc8ca7af7f1ae15b65fe3424dca9b1913ab3dd2a9b9c49d4116fdd6fa3 ;; \
      *) exit 1 ;; \
    esac \
    && archive="nils-cli-v1.36.26-${target}" \
    && curl --fail --location --retry 3 "https://github.com/sympoies/nils-cli/releases/download/v1.36.26/${archive}.tar.gz" -o /tmp/nils.tar.gz \
    && printf '%s  /tmp/nils.tar.gz\n' "$digest" | sha256sum --check \
    && mkdir /opt/nils \
    && tar -xzf /tmp/nils.tar.gz -C /opt/nils --strip-components=1 \
       "${archive}/bin/agent-session" "${archive}/LICENSE" \
       "${archive}/THIRD_PARTY_LICENSES.md" "${archive}/THIRD_PARTY_NOTICES.md" \
    && install -m 0755 /opt/nils/bin/agent-session /usr/local/bin/agent-session \
    && rm /tmp/nils.tar.gz

RUN npm install --global pnpm@11.9.0 @openai/codex@0.162.1 \
    && mkdir -p /usr/local/share/licenses/codex \
    && curl --fail --location https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/LICENSE -o /usr/local/share/licenses/codex/LICENSE \
    && curl --fail --location https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/NOTICE -o /usr/local/share/licenses/codex/NOTICE \
    && printf '%s\n' \
       'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc  /usr/local/share/licenses/codex/LICENSE' \
       '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915  /usr/local/share/licenses/codex/NOTICE' \
       | sha256sum --check

WORKDIR /opt/salon
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps/workspace ./apps/workspace
COPY assets/brand ./assets/brand
COPY docker ./docker
RUN pnpm install --frozen-lockfile \
    && pnpm run build

ENV HOME=/home/node \
    CODEX_HOME=/home/node/.codex \
    XDG_STATE_HOME=/home/node/.local/state \
    XDG_RUNTIME_DIR=/run/salon \
    AGENT_HOME=/home/node/.local/state/agent-runtime-kit \
    AGENT_SESSION_STATE_DIR=/home/node/.local/state/agent-session
RUN mkdir -p /home/node/Project/workspace /home/node/.codex /home/node/.local/state /run/salon \
    && chown -R node:node /home/node/Project /home/node/.codex /home/node/.local /run/salon
USER node
WORKDIR /home/node/Project/workspace
EXPOSE 3000
CMD ["node", "/opt/salon/docker/start.mjs"]
