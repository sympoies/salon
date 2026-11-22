# syntax=docker/dockerfile:1
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# The released GNU agent-session binary requires trixie's newer glibc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep tmux zsh \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu; digest=c5ce2d3ab321669c4712e79bd15128a4b8dc8d1ff8dfd70c34aa39ef1c46a0b0 ;; \
      arm64) target=aarch64-unknown-linux-gnu; digest=f9c12e8c3be68720cd02dd9f067cb9f903161d797a017fd1e86abcec684d5e11 ;; \
      *) exit 1 ;; \
    esac \
    && archive="nils-cli-v1.42.1-${target}" \
    && curl --fail --location --retry 3 "https://github.com/sympoies/nils-cli/releases/download/v1.42.1/${archive}.tar.gz" -o /tmp/nils.tar.gz \
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


# Use the official platform binary and retain its bundled legal files.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    DISABLE_UPDATES=1
RUN case "$TARGETARCH" in \
      amd64) target=x64; digest=f469fe57b0ed27c3359f3b4ff42783565f60dd1b6b7a923bace153c8f4519d97bc0facde6c81ca982ecebc16aeb9cb803f45f493ce520cdfcb3d56728ec19ecd ;; \
      arm64) target=arm64; digest=578c9a9c0639100e54a70c113ed8d27ea0db36a0255097959f7358670d808264478dda52b0bb470336f14577e40276e3c135f3134b9e763431518d360113dcb0 ;; \
      *) exit 1 ;; \
    esac \
    && package="claude-code-linux-${target}" \
    && curl --fail --location --retry 3 "https://registry.npmjs.org/@anthropic-ai/${package}/-/${package}-2.1.330.tgz" -o /tmp/claude.tgz \
    && printf '%s  /tmp/claude.tgz\n' "$digest" | sha512sum --check \
    && mkdir -p /usr/local/share/licenses/claude \
    && tar -xzf /tmp/claude.tgz -C /usr/local/share/licenses/claude --strip-components=1 package/LICENSE.md package/README.md \
    && tar -xzf /tmp/claude.tgz -C /usr/local/bin --strip-components=1 package/claude \
    && install -d -m 0700 -o node -g node "$CLAUDE_CONFIG_DIR" \
    && rm /tmp/claude.tgz

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
CMD ["node", "/opt/salon/docker/start.ts"]
