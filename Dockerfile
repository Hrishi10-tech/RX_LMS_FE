# syntax=docker/dockerfile:1.6

# ---- Stage 1: build the static bundle --------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# VITE_* values are inlined by `vite build`, so anything set here is frozen
# into the bundle and cannot be changed by a restart — only by a rebuild.
#
# So this is deliberately EMPTY. The app defaults to the relative path `/api`,
# which nginx (see nginx.conf) proxies to the backend from the same origin the
# page was served from. One image is therefore correct on localhost, on
# staging and in production, under any hostname, with no build arg.
#
# The old default was `http://localhost:3000/api`. Building the prod image
# without overriding it produced an app that pointed every visitor's browser
# at their own machine — working perfectly for whoever built it and for no one
# else, with nothing in the running container able to correct it.
#
# Set this ONLY when the API is on a genuinely different origin to the UI.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# Demo quick-login panel. Empty (off) unless a local build asks for it — the
# list of addresses is only compiled in when this is 'true'.
ARG VITE_SHOW_DEMO_LOGINS=
ENV VITE_SHOW_DEMO_LOGINS=$VITE_SHOW_DEMO_LOGINS

# Install deps first for layer caching.
COPY package*.json ./
RUN npm ci

# Copy sources and build. `npm run build` runs `tsc && vite build`,
# producing the static bundle in dist/.
COPY . .
RUN npm run build

# ---- Stage 2: nginx serves dist/ -------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Replace the default nginx site with our SPA-aware config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Included per-location by default.conf — see that file for why it is separate.
COPY security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY csp.conf /etc/nginx/conf.d/csp.conf

# Pin the CSP's connect-src to the API this bundle was built against.
#
# The directive used to allow `http: https: ws: wss:` — every origin on the
# internet — because the API host is a build-time setting and differs between
# production and local Docker. But connect-src is precisely the directive that
# says where an injected script may send data, so leaving it open discarded
# most of the protection the rest of the policy buys.
#
# The origin is derived from the SAME build arg the bundle uses, so the policy
# and the code cannot drift apart. The websocket companion is added explicitly
# because Socket.IO upgrades to ws:// or wss:// on that host and CSP treats
# those as separate schemes. An empty arg means the API shares the UI's origin,
# and the directive collapses to 'self' alone.
ARG VITE_API_BASE_URL=
RUN set -eu; \
    origin="$(printf '%s' "${VITE_API_BASE_URL}" | sed -E 's#^(https?://[^/]+).*#\1#')"; \
    if [ -n "$origin" ]; then \
      ws="$(printf '%s' "$origin" | sed -E 's#^http#ws#')"; \
      allow="$origin $ws"; \
    else \
      allow=""; \
    fi; \
    sed -i "s#__API_ORIGIN__#${allow}#" /etc/nginx/conf.d/csp.conf; \
    echo "CSP connect-src: 'self' ${allow:-(same origin only)}"; \
    grep -o "connect-src[^;]*" /etc/nginx/conf.d/csp.conf

# Drop in the static bundle.
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 5173

# nginx already runs as PID 1 with proper signal handling; no need for
# tini here.
CMD ["nginx", "-g", "daemon off;"]
