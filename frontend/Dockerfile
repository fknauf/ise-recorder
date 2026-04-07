FROM node:lts-alpine AS base

FROM base AS deps
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

FROM base AS runner

RUN apk update && apk upgrade --no-cache

WORKDIR /app

ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

#COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV ISE_RECORD_API_URL=

HEALTHCHECK \
    --interval=5m \
    --timeout=5s \
    --start-period=5s \
    CMD wget --spider --tries=1 "http://127.0.0.1:${PORT}"

CMD [ "node", "server.js" ]
